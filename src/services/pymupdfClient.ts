import type { NormalizedBbox, TextRegion } from "./ai/types.js";

export interface PyMuPdfSpan {
  text: string;
  bbox: NormalizedBbox;
  font?: string;
  size?: number;
}

export interface PyMuPdfBlock {
  text: string;
  bbox: NormalizedBbox;
  spans: PyMuPdfSpan[];
}

export interface PyMuPdfImageRef {
  xref: number;
  bbox: NormalizedBbox;
}

export interface PyMuPdfPageLayout {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  spans: PyMuPdfSpan[];
  blocks: PyMuPdfBlock[];
  images: PyMuPdfImageRef[];
}

export interface PyMuPdfDocumentLayout {
  pages: PyMuPdfPageLayout[];
}

function getPyMuPdfUrl(): string | null {
  const url = process.env.PYMUPDF_URL?.trim();
  return url || null;
}

export function isPyMuPdfConfigured(): boolean {
  return !!getPyMuPdfUrl();
}

export function usePyMuPdfPipeline(): boolean {
  const flag = process.env.USE_PYMUPDF_PIPELINE?.trim().toLowerCase();
  return flag === "true" || flag === "1";
}

async function postForm(
  endpoint: string,
  buffer: Buffer,
  fileName: string,
  fields: Record<string, string> = {}
): Promise<Response> {
  const baseUrl = getPyMuPdfUrl();
  if (!baseUrl) {
    throw new Error("PYMUPDF_URL is not configured.");
  }
  const timeoutMs = Number(process.env.PYMUPDF_TIMEOUT_MS) || 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: "application/pdf" }), fileName);
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
    return await fetch(`${baseUrl.replace(/\/$/, "")}${endpoint}`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function pymupdfPageCount(buffer: Buffer, fileName = "document.pdf"): Promise<number> {
  const res = await postForm("/page-count", buffer, fileName);
  if (!res.ok) {
    throw new Error(`PyMuPDF page-count HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { pageCount: number };
  return data.pageCount;
}

export async function pymupdfExtractText(
  buffer: Buffer,
  fileName = "document.pdf",
  pageNumber?: number
): Promise<string> {
  const fields: Record<string, string> = {};
  if (pageNumber != null) fields.page_number = String(pageNumber);
  const res = await postForm("/extract-text", buffer, fileName, fields);
  if (!res.ok) {
    throw new Error(`PyMuPDF extract-text HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { text: string };
  return data.text;
}

export async function pymupdfExtractLayout(
  buffer: Buffer,
  fileName = "document.pdf",
  pageNumber?: number
): Promise<PyMuPdfDocumentLayout> {
  const fields: Record<string, string> = {};
  if (pageNumber != null) fields.page_number = String(pageNumber);
  const res = await postForm("/extract-layout", buffer, fileName, fields);
  if (!res.ok) {
    throw new Error(`PyMuPDF extract-layout HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PyMuPdfDocumentLayout;
}

export async function pymupdfRenderPage(
  buffer: Buffer,
  pageNumber: number,
  dpi = 150,
  fileName = "document.pdf"
): Promise<Buffer> {
  const res = await postForm("/render-page", buffer, fileName, {
    page_number: String(pageNumber),
    dpi: String(dpi),
  });
  if (!res.ok) {
    throw new Error(`PyMuPDF render-page HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { data: string };
  return Buffer.from(data.data, "base64");
}

export async function pymupdfClipPage(
  buffer: Buffer,
  pageNumber: number,
  bbox: NormalizedBbox,
  dpi = 150,
  fileName = "document.pdf"
): Promise<Buffer> {
  const [x, y, w, h] = bbox;
  const res = await postForm("/clip-page", buffer, fileName, {
    page_number: String(pageNumber),
    x: String(x),
    y: String(y),
    w: String(w),
    h: String(h),
    dpi: String(dpi),
  });
  if (!res.ok) {
    throw new Error(`PyMuPDF clip-page HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { data: string };
  return Buffer.from(data.data, "base64");
}

const WORD_RE = /^[A-Za-z][A-Za-z'-]{0,24}$/;

function wordBboxWithinSpan(
  span: PyMuPdfSpan,
  wordStart: number,
  wordEnd: number
): NormalizedBbox {
  const [sx, sy, sw, sh] = span.bbox;
  const textLen = Math.max(span.text.length, 1);
  const relStart = wordStart / textLen;
  const relEnd = wordEnd / textLen;
  const pad = 0.001;
  const x = sx + sw * relStart;
  const w = Math.max(sw * (relEnd - relStart), 0.005);
  return [Math.max(0, x - pad), sy, Math.min(1 - x, w + pad * 2), sh];
}

/** Build clickable text regions from PyMuPDF spans (Part 5–7). */
export function spansToTextRegions(spans: PyMuPdfSpan[], prefix = "r"): TextRegion[] {
  const regions: TextRegion[] = [];
  let idx = 0;

  for (const span of spans) {
    const text = span.text;
    if (!text.trim()) continue;

    const matches = [...text.matchAll(/\S+/g)];
    for (const match of matches) {
      const raw = match[0]!;
      const cleaned = raw.replace(/[.,/#!$%^&*;:{}=\-_`~()?"\n]/g, "").trim();
      if (!cleaned || !WORD_RE.test(cleaned)) continue;

      const start = match.index ?? 0;
      const end = start + raw.length;
      regions.push({
        id: `${prefix}${++idx}`,
        text: cleaned,
        bbox: wordBboxWithinSpan(span, start, end),
      });
    }
  }

  return regions;
}
