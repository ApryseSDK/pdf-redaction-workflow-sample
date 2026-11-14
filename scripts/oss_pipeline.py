"""The open-source redaction stack, assembled the way such a pipeline is usually put together.

  1. PyMuPDF extracts each page's words with their positions
  2. Presidio scans that text and returns matches with character positions
  3. Those positions are mapped back to boxes on the page
  4. PyMuPDF applies true redaction to the boxes and saves the whole file
  5. (--scrub)            PyMuPDF scrub() clears metadata and hidden data, as a separate step
  6. (--ocr)              scanned pages get OCR first (Tesseract), so there is text to match
  7. (--drop-annotations) comments and other annotations are deleted explicitly
  8. (--term "text")      extra literal text to redact, for things Presidio's default rules miss

  --detect-only  prints what Presidio finds and changes nothing (no file is written)

Usage:
  python scripts/oss_pipeline.py originals/sample_claim.pdf --detect-only
  python scripts/oss_pipeline.py originals/sample_claim.pdf output/oss_plain.pdf
  python scripts/oss_pipeline.py originals/sample_claim.pdf output/oss_full.pdf --scrub --ocr
Then:  python scripts/verify.py output/oss_plain.pdf
"""

import argparse
import logging
import subprocess
from pathlib import Path

# Presidio's email recognizer tries to download a public-suffix list and falls back to a bundled one.
# Harmless, but noisy on machines without open internet access.
logging.getLogger("tldextract").setLevel(logging.CRITICAL)

import pymupdf
from presidio_analyzer import AnalyzerEngine

ENTITIES = [
    "US_SSN",
    "CREDIT_CARD",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "PERSON",
    "LOCATION",
]


def tessdata_dir() -> str | None:
    """Find tesseract's language data so PyMuPDF's OCR can use it."""
    out = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True)
    line = out.stdout.splitlines()[0] if out.stdout else ""
    # e.g. 'List of available languages in "/usr/share/tesseract-ocr/5/tessdata/" (1):'
    return line.split('"')[1] if '"' in line else None


def page_words(page: pymupdf.Page, ocr: bool, tessdata: str | None):
    if ocr and not page.get_text("words"):
        tp = page.get_textpage_ocr(
            language="eng", dpi=200, full=True, tessdata=tessdata
        )
        return page.get_text("words", textpage=tp, sort=True)
    return page.get_text("words", sort=True)


def lines_of(words):
    """Group words by text line. Scanning line by line stops a match from spilling onto the next line."""
    groups: dict = {}
    for w in words:
        groups.setdefault((w[5], w[6]), []).append(w)
    return list(groups.values())


def build_text(line_words):
    """Join one line's words into a string, remembering which characters belong to which word."""
    text, spans = "", []
    for i, w in enumerate(line_words):
        if i:
            text += " "
        spans.append((len(text), len(text) + len(w[4]), i))
        text += w[4]
    return text, spans


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path)
    ap.add_argument(
        "dst", type=Path, nargs="?", help="output PDF (not needed with --detect-only)"
    )
    ap.add_argument(
        "--detect-only", action="store_true", help="print detections, change nothing"
    )
    ap.add_argument(
        "--scrub",
        action="store_true",
        help="also clear metadata, attachments, hidden data",
    )
    ap.add_argument(
        "--ocr", action="store_true", help="OCR pages that have no text layer"
    )
    ap.add_argument(
        "--drop-annotations",
        action="store_true",
        help="delete comments and other annotations",
    )
    ap.add_argument(
        "--term",
        action="append",
        default=[],
        help="extra literal text to redact (repeatable)",
    )
    ap.add_argument("--min-score", type=float, default=0.4)
    args = ap.parse_args()
    if not args.detect_only and args.dst is None:
        ap.error("dst is required unless --detect-only is given")

    analyzer = AnalyzerEngine()  # spaCy en_core_web_lg under the hood
    tessdata = tessdata_dir() if args.ocr else None
    doc = pymupdf.open(args.src)

    print(f"\nPresidio detections (min score {args.min_score})")
    total_boxes, dropped = 0, 0
    for page in doc:
        words = page_words(page, args.ocr, tessdata)
        if not words:
            print(f"  page {page.number + 1}: no text to scan")
            continue
        for line in lines_of(words):
            text, spans = build_text(line)
            found = [
                (r.entity_type, r.start, r.end, f"score {r.score:.2f}")
                for r in analyzer.analyze(
                    text=text,
                    language="en",
                    entities=ENTITIES,
                    score_threshold=args.min_score,
                )
            ]
            low = text.lower()
            for term in args.term:
                pos = low.find(term.lower())
                while pos != -1:
                    found.append(("TERM", pos, pos + len(term), "literal"))
                    pos = low.find(term.lower(), pos + len(term))
            for kind, start, end, note in found:
                hit = [line[k] for (s, e, k) in spans if s < end and e > start]
                if not args.detect_only:
                    for w in hit:
                        page.add_redact_annot(pymupdf.Rect(w[:4]), fill=(0, 0, 0))
                total_boxes += len(hit)
                print(
                    f"  page {page.number + 1}: {kind:<14} {text[start:end]!r:<34} {note}"
                )
        if not args.detect_only:
            page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_PIXELS)
            if args.drop_annotations:
                for annot in list(page.annots() or []):
                    page.delete_annot(annot)
                    dropped += 1

    if args.detect_only:
        print(
            f"\n{total_boxes} word boxes would be redacted. Detect-only: nothing changed, no file written."
        )
        return

    if args.scrub:
        doc.scrub(
            metadata=True,
            xml_metadata=True,
            attached_files=True,
            embedded_files=True,
            javascript=True,
            thumbnails=True,
            hidden_text=True,
        )
        print("\nscrub(): metadata, attachments, hidden text cleared")
    if args.drop_annotations:
        print(f"annotations deleted: {dropped}")

    args.dst.parent.mkdir(exist_ok=True, parents=True)
    doc.save(
        args.dst, garbage=4, deflate=True, clean=True
    )  # full save, not incremental
    print(f"\n{total_boxes} word boxes redacted -> {args.dst}")


if __name__ == "__main__":
    main()
