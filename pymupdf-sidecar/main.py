import base64
import os
import tempfile
from pathlib import Path
from typing import Any

import pymupdf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

app = FastAPI(title="Learn Now PyMuPDF Sidecar", version="1.0.0")

DEFAULT_DPI = 150


def _open_doc(content: bytes) -> pymupdf.Document:
    if not content:
        raise HTTPException(status_code=400, detail="Empty file upload.")
    try:
        return pymupdf.open(stream=content, filetype="pdf")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Cannot open PDF: {exc}") from exc


def _norm_bbox(rect: pymupdf.Rect, page_w: float, page_h: float) -> list[float]:
    if page_w <= 0 or page_h <= 0:
        return [0.0, 0.0, 0.0, 0.0]
    x0 = max(0.0, min(1.0, rect.x0 / page_w))
    y0 = max(0.0, min(1.0, rect.y0 / page_h))
    x1 = max(0.0, min(1.0, rect.x1 / page_w))
    y1 = max(0.0, min(1.0, rect.y1 / page_h))
    return [x0, y0, max(0.0, x1 - x0), max(0.0, y1 - y0)]


def _extract_layout_page(page: pymupdf.Page) -> dict[str, Any]:
    page_w = float(page.rect.width)
    page_h = float(page.rect.height)
    data = page.get_text("dict")
    spans_out: list[dict[str, Any]] = []
    blocks_out: list[dict[str, Any]] = []

    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue
        block_spans: list[dict[str, Any]] = []
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = (span.get("text") or "").strip()
                if not text:
                    continue
                bbox = span.get("bbox")
                if not bbox or len(bbox) != 4:
                    continue
                rect = pymupdf.Rect(bbox)
                entry = {
                    "text": text,
                    "bbox": _norm_bbox(rect, page_w, page_h),
                    "font": span.get("font"),
                    "size": span.get("size"),
                }
                spans_out.append(entry)
                block_spans.append(entry)
        if block_spans:
            xs = [s["bbox"][0] for s in block_spans]
            ys = [s["bbox"][1] for s in block_spans]
            ws = [s["bbox"][0] + s["bbox"][2] for s in block_spans]
            hs = [s["bbox"][1] + s["bbox"][3] for s in block_spans]
            blocks_out.append({
                "text": " ".join(s["text"] for s in block_spans),
                "bbox": [min(xs), min(ys), max(ws) - min(xs), max(hs) - min(ys)],
                "spans": block_spans,
            })

    images_out: list[dict[str, Any]] = []
    for img in page.get_images(full=True):
        xref = img[0]
        try:
            rects = page.get_image_rects(xref)
            for rect in rects:
                images_out.append({
                    "xref": xref,
                    "bbox": _norm_bbox(rect, page_w, page_h),
                })
        except Exception:
            continue

    return {
        "pageNumber": page.number + 1,
        "width": page_w,
        "height": page_h,
        "text": page.get_text(),
        "spans": spans_out,
        "blocks": blocks_out,
        "images": images_out,
    }


class ClipRequest(BaseModel):
    pageNumber: int = Field(ge=1)
    bbox: list[float] = Field(min_length=4, max_length=4)
    dpi: int = Field(default=DEFAULT_DPI, ge=72, le=300)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok"}


@app.post("/page-count")
async def page_count(file: UploadFile = File(...)) -> dict[str, int]:
    content = await file.read()
    doc = _open_doc(content)
    try:
        return {"pageCount": len(doc)}
    finally:
        doc.close()


@app.post("/extract-text")
async def extract_text(
    file: UploadFile = File(...),
    page_number: int | None = Form(default=None),
) -> dict[str, Any]:
    content = await file.read()
    doc = _open_doc(content)
    try:
        if page_number is not None:
            if page_number < 1 or page_number > len(doc):
                raise HTTPException(status_code=400, detail=f"Invalid page {page_number}")
            text = doc[page_number - 1].get_text()
            return {"text": text, "pageNumber": page_number}
        parts = [doc[i].get_text() for i in range(len(doc))]
        return {"text": "\n\n".join(parts), "pageCount": len(doc)}
    finally:
        doc.close()


@app.post("/extract-layout")
async def extract_layout(
    file: UploadFile = File(...),
    page_number: int | None = Form(default=None),
) -> dict[str, Any]:
    content = await file.read()
    doc = _open_doc(content)
    try:
        if page_number is not None:
            if page_number < 1 or page_number > len(doc):
                raise HTTPException(status_code=400, detail=f"Invalid page {page_number}")
            return {"pages": [_extract_layout_page(doc[page_number - 1])]}
        return {"pages": [_extract_layout_page(doc[i]) for i in range(len(doc))]}
    finally:
        doc.close()


@app.post("/render-page")
async def render_page(
    file: UploadFile = File(...),
    page_number: int = Form(...),
    dpi: int = Form(default=DEFAULT_DPI),
) -> dict[str, Any]:
    content = await file.read()
    doc = _open_doc(content)
    try:
        if page_number < 1 or page_number > len(doc):
            raise HTTPException(status_code=400, detail=f"Invalid page {page_number}")
        page = doc[page_number - 1]
        pix = page.get_pixmap(dpi=dpi)
        png_bytes = pix.tobytes("png")
        return {
            "mimeType": "image/png",
            "data": base64.b64encode(png_bytes).decode("ascii"),
            "pageNumber": page_number,
        }
    finally:
        doc.close()


@app.post("/clip-page")
async def clip_page(
    file: UploadFile = File(...),
    page_number: int = Form(...),
    x: float = Form(...),
    y: float = Form(...),
    w: float = Form(...),
    h: float = Form(...),
    dpi: int = Form(default=DEFAULT_DPI),
) -> dict[str, Any]:
    content = await file.read()
    doc = _open_doc(content)
    try:
        if page_number < 1 or page_number > len(doc):
            raise HTTPException(status_code=400, detail=f"Invalid page {page_number}")
        page = doc[page_number - 1]
        pw = float(page.rect.width)
        ph = float(page.rect.height)
        clip = pymupdf.Rect(x * pw, y * ph, (x + w) * pw, (y + h) * ph)
        clip = clip & page.rect
        if clip.is_empty:
            raise HTTPException(status_code=400, detail="Clip rectangle is empty")
        pix = page.get_pixmap(dpi=dpi, clip=clip)
        png_bytes = pix.tobytes("png")
        return {
            "mimeType": "image/png",
            "data": base64.b64encode(png_bytes).decode("ascii"),
            "pageNumber": page_number,
        }
    finally:
        doc.close()
