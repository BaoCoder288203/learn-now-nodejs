import { extractTextFromPdfBuffer } from "./pdfService.js";

/**
 * Single entry point for document text extraction.
 * TOEIC imports use PyMuPDF first; this fallback keeps PDF text extraction local.
 */
export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  _fileName = "document.pdf"
): Promise<string> {
  if (mimeType === "application/pdf") {
    return extractTextFromPdfBuffer(buffer);
  }

  return "";
}
