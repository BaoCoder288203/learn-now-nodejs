import { extractTextFromPdfBuffer } from "./pdfService.js";

function getMarkitdownUrl(): string | null {
  const url = process.env.MARKITDOWN_URL?.trim();
  return url || null;
}

async function extractViaMarkitdown(buffer: Buffer, fileName: string, mimeType: string): Promise<string> {
  const baseUrl = getMarkitdownUrl();
  if (!baseUrl) {
    throw new Error("MARKITDOWN_URL is not configured.");
  }

  const timeoutMs = Number(process.env.MARKITDOWN_TIMEOUT_MS) || 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: mimeType }), fileName || "document.pdf");

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/convert`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`MarkItDown HTTP ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as { text?: string; markdown?: string };
    const text = payload.text || payload.markdown || "";
    if (!text.trim()) {
      throw new Error("MarkItDown không trả về nội dung hợp lệ.");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Single entry point for document text extraction.
 * Uses MarkItDown sidecar when MARKITDOWN_URL is set, otherwise pdf-parse for PDFs.
 */
export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  fileName = "document.pdf"
): Promise<string> {
  if (getMarkitdownUrl()) {
    try {
      return await extractViaMarkitdown(buffer, fileName, mimeType);
    } catch (error) {
      console.warn(
        "[DocumentExtract] MarkItDown failed, falling back to pdf-parse:",
        error instanceof Error ? error.message : error
      );
    }
  }

  if (mimeType === "application/pdf") {
    return extractTextFromPdfBuffer(buffer);
  }

  return "";
}
