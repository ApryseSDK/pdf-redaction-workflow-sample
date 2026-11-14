"""Build the fictional sample PDF used across the redaction demos.

Planted items (see planted.json): text-layer PII, a scanned-image page,
metadata, a sticky-note annotation, and an embedded file. Everything is fake.

Usage: python make_sample.py
Writes: originals/sample_claim.pdf
"""
import io
import json
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

ROOT = Path(__file__).parent
OUT = ROOT / "originals" / "sample_claim.pdf"
PLANTED = {i["id"]: i["value"] for i in json.loads((ROOT / "planted.json").read_text())["items"]}

W, H = letter


def page_one(c: canvas.Canvas) -> None:
    c.setFont("Helvetica-Bold", 16)
    c.drawString(72, H - 80, "Example Mutual Insurance Co.")
    c.setFont("Helvetica", 11)
    c.drawString(72, H - 98, "Claims Review Department   |   Claim 2026-0042")

    c.setFont("Helvetica-Bold", 12)
    c.drawString(72, H - 140, "Claimant information")
    c.setFont("Helvetica", 11)
    rows = [
        ("Name:", PLANTED["name_text"]),
        ("Address:", f"{PLANTED['addr_text']}, Springfield"),
        ("Social Security No.:", PLANTED["ssn_text"]),
        ("Payment card on file:", PLANTED["card_text"]),
        ("Contact email:", PLANTED["email_text"]),
    ]
    y = H - 162
    for label, value in rows:
        c.drawString(72, y, label)
        c.drawString(230, y, value)
        y -= 20

    c.setFont("Helvetica-Bold", 12)
    c.drawString(72, y - 18, "Review summary")
    c.setFont("Helvetica", 11)
    text = c.beginText(72, y - 40)
    text.setLeading(16)
    for line in [
        f"{PLANTED['name_text']} filed a claim for water damage at the address above.",
        "The adjuster inspected the property and confirmed the loss on the date",
        "of the report. Payment will be issued to the card on file once the",
        "supporting documents on page 2 have been reviewed.",
        "",
        "This is a fictional document created for a software demonstration.",
    ]:
        text.textLine(line)
    c.drawText(text)
    c.showPage()


def scanned_page_image() -> bytes:
    """A page of 'scanned' text: pixels only, no text layer."""
    img = Image.new("L", (1275, 1650), 250)  # 150 dpi letter
    d = ImageDraw.Draw(img)
    big = ImageFont.load_default(size=44)
    small = ImageFont.load_default(size=34)
    d.text((110, 140), "Example Mutual Insurance Co.", font=big, fill=20)
    d.text((110, 215), "Signed supporting form (scanned copy)", font=small, fill=40)
    d.text((110, 380), f"Claimant:  {PLANTED['name_text']}", font=small, fill=30)
    d.text((110, 450), f"SSN:  {PLANTED['ssn_scan']}", font=small, fill=30)
    d.text((110, 520), "Signature:  ____________________", font=small, fill=30)
    img = img.rotate(0.4, resample=Image.BICUBIC, fillcolor=250)  # slight skew, like a real scan
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def main() -> None:
    OUT.parent.mkdir(exist_ok=True)
    tmp = io.BytesIO()
    c = canvas.Canvas(tmp, pagesize=letter)
    page_one(c)
    c.drawImage(ImageReader(io.BytesIO(scanned_page_image())), 0, 0, width=W, height=H)
    c.showPage()
    c.save()

    doc = pymupdf.open(stream=tmp.getvalue(), filetype="pdf")
    doc.set_metadata({
        "title": PLANTED["meta_title"],
        "author": PLANTED["meta_author"],
        "subject": "Claim review",
        "creator": "demo-sample-builder",
        "producer": "",
    })
    # Sticky-note comment holding PII
    annot = doc[0].add_text_annot(pymupdf.Point(500, 120), f"Call claimant at {PLANTED['annot_note']} before payment.")
    annot.set_info(title="Reviewer")
    annot.update()
    # Embedded file holding PII
    doc.embfile_add(
        "intake_notes.txt",
        f"Intake notes (fictional)\nSSN on intake form: {PLANTED['attachment']}\n".encode(),
        desc="Intake notes",
    )
    doc.save(OUT, garbage=3, deflate=True)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {doc.page_count} pages)")


if __name__ == "__main__":
    main()
