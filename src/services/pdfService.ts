import fs from "fs/promises";
import { PDFParse } from "pdf-parse";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

export async function extractTextFromPdfBuffer(buffer: Buffer): Promise<string> {
  const pdf = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await pdf.getText();
  return result.text;
}

export async function extractTextFromPdf(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return extractTextFromPdfBuffer(buffer);
}

export function bufferToBase64(
  buffer: Buffer,
  mimeType: string
): { data: string; mimeType: string } {
  return {
    data: buffer.toString("base64"),
    mimeType,
  };
}

export async function readFileAsBase64(
  filePath: string
): Promise<{ data: string; mimeType: string }> {
  const buffer = await fs.readFile(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return bufferToBase64(buffer, MIME_BY_EXT[ext] || "application/octet-stream");
}

export function mimeTypeFromKey(s3Key: string, fallback = "application/octet-stream"): string {
  const ext = s3Key.split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXT[ext] || fallback;
}
