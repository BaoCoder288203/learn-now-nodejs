import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from markitdown import MarkItDown

app = FastAPI(title="Learn Now MarkItDown Sidecar", version="1.0.0")

_converter = MarkItDown(enable_plugins=False)

ALLOWED_EXTENSIONS = {
    ".pdf",
    ".doc",
    ".docx",
    ".ppt",
    ".pptx",
    ".xls",
    ".xlsx",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".txt",
    ".csv",
    ".json",
    ".xml",
    ".html",
    ".htm",
}


def _suffix_from_filename(filename: str | None, mime_type: str | None) -> str:
    if filename:
        ext = Path(filename).suffix.lower()
        if ext in ALLOWED_EXTENSIONS:
            return ext

    mime_map = {
        "application/pdf": ".pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/msword": ".doc",
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "text/plain": ".txt",
    }
    if mime_type and mime_type in mime_map:
        return mime_map[mime_type]

    return ".bin"


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/convert")
async def convert(file: UploadFile = File(...)) -> dict[str, str]:
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file upload.")

    suffix = _suffix_from_filename(file.filename, file.content_type)
    tmp_path: str | None = None

    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        result = _converter.convert_local(tmp_path)
        text = (result.text_content or "").strip()
        if not text:
            raise HTTPException(
                status_code=422,
                detail="MarkItDown returned empty content for this file.",
            )

        return {"text": text, "markdown": text}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Conversion failed: {exc}",
        ) from exc
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
