"""Independent check: what sensitive content can still be recovered from a PDF, or a folder of PDFs?

Deliberately uses tools that are NOT the ones doing the redaction:
  - pdftotext (poppler)   text layer
  - pdftoppm + tesseract  OCR of the rendered pages (catches text baked into images)
  - pikepdf               metadata, annotations, attachments
  - zlib scan of the file raw bytes (catches content left behind by incremental saves)

What to look for (combine as needed):
  --planted           the 10 fake items in planted.json (the default when nothing else is given)
  --term TEXT         a literal string, repeatable
  --terms-file FILE   one literal string per line
  --pattern NAME      ssn, card, email or phone, repeatable. Card matches must pass the Luhn check.

Usage:
  python scripts/verify.py originals/sample_claim.pdf
  python scripts/verify.py output/redacted.pdf --json
  python scripts/verify.py ~/batch_output --pattern ssn --pattern card --pattern email --term "Jordan Example"
  python scripts/verify.py a.pdf b.pdf --no-ocr

A folder is searched for *.pdf, including subfolders.
The report gives locations and counts only. It never prints the matched text, so the report is safe to keep.
Exit code: 0 if nothing was found in any file, 1 if something is recoverable, 2 if a file could not be checked.

This is a check for recoverable content, not proof that none exists. It cannot see what it was not told to look for.
The "raw" channel scans decompressed bytes and can occasionally match number sequences that are not real data.
"""

import argparse
import base64
import json
import re
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

import pikepdf

ROOT = Path(__file__).resolve().parent.parent
LOCATIONS = ["text", "ocr", "metadata", "annotation", "attachment", "raw"]

PATTERNS = {
    "ssn": re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)"),
    "card": re.compile(r"(?<!\d)(?:\d{4}[ -]){3}\d{4}(?!\d)|(?<!\d)\d{15,16}(?!\d)"),
    "email": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    "phone": re.compile(
        r"(?<!\d)(?:\+?1[-. ])?(?:\(\d{3}\)\s?|\d{3}[-.])\d{3}[-.]\d{4}(?!\d)"
    ),
}
PATTERN_LABELS = {
    "ssn": "SSN pattern",
    "card": "Card number pattern",
    "email": "Email pattern",
    "phone": "Phone pattern",
}


def squash(s: str) -> str:
    return re.sub(r"[\s\-]", "", s).lower()


def luhn(digits: str) -> bool:
    total, flip = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if flip:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        flip = not flip
    return total % 10 == 0


def text_layer(pdf: Path) -> str:
    return subprocess.run(
        ["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True
    ).stdout


def ocr_text(pdf: Path) -> str:
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(
            ["pdftoppm", "-r", "200", "-png", str(pdf), f"{d}/p"],
            check=True,
            capture_output=True,
        )
        out = []
        for png in sorted(Path(d).glob("p*.png")):
            out.append(
                subprocess.run(
                    ["tesseract", str(png), "-", "--psm", "6"],
                    capture_output=True,
                    text=True,
                ).stdout
            )
        return "\n".join(out)


def metadata_text(pdf: Path) -> str:
    with pikepdf.open(pdf) as p:
        parts = [str(v) for v in p.docinfo.values()]
        try:
            parts.append(p.Root.Metadata.read_bytes().decode("utf-8", "ignore"))
        except Exception:
            pass
        return "\n".join(parts)


def annotation_text(pdf: Path) -> str:
    parts = []
    with pikepdf.open(pdf) as p:
        for page in p.pages:
            for a in page.get("/Annots", []) or []:
                for key in ("/Contents", "/T", "/Subj", "/RC", "/V"):
                    if key in a:
                        parts.append(str(a[key]))
    return "\n".join(parts)


def attachment_text(pdf: Path) -> str:
    parts = []
    with pikepdf.open(pdf) as p:
        for name, spec in p.attachments.items():
            parts.append(name)
            parts.append(spec.get_file().read_bytes().decode("utf-8", "ignore"))
    return "\n".join(parts)


def raw_text(pdf: Path) -> str:
    """File structure plus every stream that can be decoded.

    Compressed stream bytes that cannot be decoded are left out: scanning them only produces false matches.
    A stream that is already plain text is kept as it is.
    """
    data = pdf.read_bytes()
    chunks = []
    last = 0
    for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        chunks.append(data[last : m.start(1)].decode("latin-1"))
        last = m.end(1)
        body = m.group(1)
        for attempt in (
            body,
            _a85(body),
        ):  # plain Flate, or ASCII85 wrapped around Flate
            if attempt is None:
                continue
            try:
                chunks.append(
                    zlib.decompressobj().decompress(attempt).decode("latin-1")
                )
                break
            except Exception:
                continue
        else:
            printable = sum(32 <= b < 127 or b in (9, 10, 13) for b in body)
            if body and printable / len(body) > 0.9:
                chunks.append(body.decode("latin-1"))
    chunks.append(data[last:].decode("latin-1"))
    return "\n".join(chunks)


def _a85(body: bytes):
    try:
        return base64.a85decode(body.strip(), adobe=body.strip().startswith(b"<~"))
    except Exception:
        try:
            return base64.a85decode(body.strip().removesuffix(b"~>"))
        except Exception:
            return None


def build_corpus(pdf: Path, ocr: bool) -> dict:
    return {
        "text": text_layer(pdf),
        "ocr": ocr_text(pdf) if ocr else "",
        "metadata": metadata_text(pdf),
        "annotation": annotation_text(pdf),
        "attachment": attachment_text(pdf),
        "raw": raw_text(pdf),
    }


def build_checks(args) -> list:
    """Each check: {id, label, kind: 'literal'|'pattern', value}."""
    checks = []
    use_planted = args.planted or not (args.term or args.terms_file or args.pattern)
    if use_planted:
        for it in json.loads((ROOT / "planted.json").read_text())["items"]:
            checks.append(
                {
                    "id": it["id"],
                    "label": it["label"],
                    "kind": "literal",
                    "value": it["value"],
                }
            )
    terms = list(args.term or [])
    if args.terms_file:
        terms += [
            t.strip() for t in args.terms_file.read_text().splitlines() if t.strip()
        ]
    for i, t in enumerate(terms, 1):
        checks.append(
            {"id": f"term{i}", "label": f"Term {i}", "kind": "literal", "value": t}
        )
    for name in args.pattern or []:
        checks.append(
            {
                "id": name,
                "label": PATTERN_LABELS[name],
                "kind": "pattern",
                "value": name,
            }
        )
    return checks


def count_matches(check: dict, text: str, squashed: str) -> int:
    if check["kind"] == "literal":
        needle = squash(check["value"])
        return squashed.count(needle) if needle else 0
    rx = PATTERNS[check["value"]]
    found = 0
    for m in rx.finditer(text):
        if check["value"] == "card" and not luhn(re.sub(r"\D", "", m.group(0))):
            continue
        found += 1
    return found


def check_file(pdf: Path, checks: list, ocr: bool) -> dict:
    corpus = build_corpus(pdf, ocr)
    squashed = {k: squash(v) for k, v in corpus.items()}
    items = []
    for c in checks:
        where = {
            loc: n
            for loc in LOCATIONS
            if (n := count_matches(c, corpus[loc], squashed[loc]))
        }
        items.append(
            {
                "id": c["id"],
                "label": c["label"],
                "found_in": sorted(where, key=LOCATIONS.index),
                "counts": where,
            }
        )
    return {
        "file": str(pdf),
        "recoverable": sum(1 for i in items if i["found_in"]),
        "total": len(items),
        "ocr": ocr,
        "items": items,
    }


def collect(paths) -> list:
    """Returns (path, display name). Files found in a folder are shown relative to that folder."""
    files = []
    for p in paths:
        if p.is_dir():
            files += [(f, str(f.relative_to(p))) for f in sorted(p.rglob("*.pdf"))]
        else:
            files.append((p, str(p)))
    return files


def short_error(err: Exception) -> str:
    if isinstance(err, (subprocess.CalledProcessError, pikepdf.PdfError)):
        return "not a readable PDF (corrupt, encrypted or not a PDF)"
    if isinstance(err, FileNotFoundError):
        return f"missing file or tool: {err.filename}"
    return f"{type(err).__name__}"


def print_detail(r: dict) -> None:
    print(f"\n{r['file']}\n")
    print(f"{'item':<32}" + "".join(f"{loc:<12}" for loc in LOCATIONS))
    for i in r["items"]:
        row = "".join(
            f"{('FOUND' if loc in i['found_in'] else '-'):<12}" for loc in LOCATIONS
        )
        print(f"{i['label']:<32}{row}")
    print(f"\n{r['recoverable']} of {r['total']} checks still recoverable.")
    if not r["ocr"]:
        print("OCR was skipped, so text inside scanned images was not checked.")


def print_summary(results: list) -> None:
    width = max(len(r["file"]) for r in results) + 2
    print(f"\n{'file':<{width}}{'status':<14}{'checks hit':<12}where")
    for r in results:
        if r.get("error"):
            print(f"{r['file']:<{width}}{'ERROR':<14}{'-':<12}{r['error']}")
            continue
        status = "RECOVERABLE" if r["recoverable"] else "clean"
        where = sorted(
            {loc for i in r["items"] for loc in i["found_in"]}, key=LOCATIONS.index
        )
        print(
            f"{r['file']:<{width}}{status:<14}{str(r['recoverable']) + '/' + str(r['total']):<12}{', '.join(where) or '-'}"
        )
    ok = [r for r in results if not r.get("error")]
    print(
        f"\n{sum(1 for r in ok if not r['recoverable'])} of {len(results)} files clean, "
        f"{sum(1 for r in ok if r['recoverable'])} with recoverable content, "
        f"{sum(1 for r in results if r.get('error'))} could not be checked."
    )
    if ok and not ok[0]["ocr"]:
        print("OCR was skipped, so text inside scanned images was not checked.")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Check PDFs for recoverable sensitive content."
    )
    ap.add_argument("paths", nargs="+", type=Path, help="PDF files or folders")
    ap.add_argument("--json", action="store_true")
    ap.add_argument(
        "--planted",
        action="store_true",
        help="check the planted items (default when nothing else given)",
    )
    ap.add_argument(
        "--term", action="append", help="literal string to look for (repeatable)"
    )
    ap.add_argument(
        "--terms-file", type=Path, help="file with one literal string per line"
    )
    ap.add_argument(
        "--pattern",
        action="append",
        choices=sorted(PATTERNS),
        help="built-in pattern (repeatable)",
    )
    ap.add_argument(
        "--no-ocr",
        action="store_true",
        help="skip OCR (faster, but scanned images are not checked)",
    )
    args = ap.parse_args()

    files = collect(args.paths)
    if not files:
        print("No PDF files found.", file=sys.stderr)
        return 2
    checks = build_checks(args)

    results = []
    for f, shown in files:
        try:
            r = check_file(f, checks, ocr=not args.no_ocr)
            r["file"] = shown
            results.append(r)
        except Exception as err:  # corrupt, encrypted, missing tool
            results.append({"file": shown, "error": short_error(err)})

    errors = any(r.get("error") for r in results)
    found = any(r.get("recoverable") for r in results)
    if args.json:
        print(
            json.dumps(
                results[0] if len(results) == 1 else {"files": results}, indent=2
            )
        )
    elif len(results) == 1 and not errors:
        print_detail(results[0])
    else:
        print_summary(results)
    return 2 if errors else (1 if found else 0)


if __name__ == "__main__":
    sys.exit(main())
