"""Builds the 'bad redaction' PDF as an example of a bad redaction.

Black rectangles are drawn over the SSN, card number and email on page 1, but the text underneath is NOT removed.
Select the area, copy and paste it, and the hidden text appears. This is what a black box does, and what redaction does not.

Usage: python make_black_box_pdf.py
Writes originals/sample_claim_black_boxes.pdf. The original sample is never modified.
"""
from pathlib import Path

import pymupdf

ROOT = Path(__file__).parent
SRC = ROOT / "originals" / "sample_claim.pdf"
OUT = ROOT / "originals" / "sample_claim_black_boxes.pdf"
COVER = ["987-65-4321", "4111 1111 1111 1111", "jordan.example@example.com"]

doc = pymupdf.open(SRC)
page = doc[0]
for needle in COVER:
    rects = page.search_for(needle)
    if not rects:
        raise SystemExit(f"Could not find {needle!r} on page 1")
    for r in rects:
        page.draw_rect(r, color=(0, 0, 0), fill=(0, 0, 0), overlay=True)  # drawn on top; nothing is removed
doc.save(OUT)
print(f"Wrote {OUT}")
