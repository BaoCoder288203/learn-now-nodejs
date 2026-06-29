import { pdf } from "pdf-to-img";
import { uploadObject } from "./s3Service.js";
import {
  buildPart1QuestionImageKey,
  buildPassageGroupImageKey,
  buildReadingPageImageKey,
} from "./s3ObjectKey.js";

const DEFAULT_SCALE = 2;

export async function getPdfPageCount(buffer: Buffer): Promise<number> {
  const document = await pdf(buffer, { scale: DEFAULT_SCALE });
  let count = 0;
  for await (const _image of document) {
    count++;
  }
  return count;
}

export async function renderPdfPage(buffer: Buffer, pageNumber: number): Promise<Buffer> {
  if (pageNumber < 1) {
    throw new Error(`Invalid page number: ${pageNumber}`);
  }

  const document = await pdf(buffer, { scale: DEFAULT_SCALE });
  let current = 1;
  for await (const image of document) {
    if (current === pageNumber) {
      return image;
    }
    current++;
  }

  throw new Error(`PDF page ${pageNumber} not found (document has ${current - 1} pages).`);
}

export async function uploadPassageGroupImage(
  examType: string,
  testId: string,
  partNumber: number,
  groupOrder: number,
  pngBuffer: Buffer
): Promise<string> {
  const key = buildPassageGroupImageKey(examType, testId, partNumber, groupOrder);
  await uploadObject(key, pngBuffer, "image/png");
  return key;
}

export async function uploadPart1QuestionImage(
  examType: string,
  testId: string,
  questionNumber: number,
  pngBuffer: Buffer
): Promise<string> {
  const key = buildPart1QuestionImageKey(examType, testId, questionNumber);
  await uploadObject(key, pngBuffer, "image/png");
  return key;
}

export async function uploadReadingPageImage(
  examType: string,
  testId: string,
  partNumber: number,
  sourcePage: number,
  pngBuffer: Buffer
): Promise<string> {
  const key = buildReadingPageImageKey(examType, testId, partNumber, sourcePage);
  await uploadObject(key, pngBuffer, "image/png");
  return key;
}

export async function renderAndUploadPassageGroupImage(
  examPdfBuffer: Buffer,
  examType: string,
  testId: string,
  partNumber: number,
  groupOrder: number,
  sourcePage: number,
  maxPages: number
): Promise<string | null> {
  if (sourcePage < 1 || sourcePage > maxPages) {
    console.warn(
      `[PdfImage] Invalid sourcePage ${sourcePage} for Part ${partNumber} group ${groupOrder} (max ${maxPages}).`
    );
    return null;
  }

  try {
    const pngBuffer = await renderPdfPage(examPdfBuffer, sourcePage);
    return await uploadPassageGroupImage(examType, testId, partNumber, groupOrder, pngBuffer);
  } catch (error) {
    console.warn(
      `[PdfImage] Failed to render Part ${partNumber} group ${groupOrder} page ${sourcePage}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

export async function renderAndUploadPart1QuestionImage(
  examPdfBuffer: Buffer,
  examType: string,
  testId: string,
  questionNumber: number,
  sourcePage: number,
  maxPages: number
): Promise<string | null> {
  if (sourcePage < 1 || sourcePage > maxPages) {
    console.warn(
      `[PdfImage] Invalid sourcePage ${sourcePage} for Part 1 Q${questionNumber} (max ${maxPages}).`
    );
    return null;
  }

  try {
    const pngBuffer = await renderPdfPage(examPdfBuffer, sourcePage);
    return await uploadPart1QuestionImage(examType, testId, questionNumber, pngBuffer);
  } catch (error) {
    console.warn(
      `[PdfImage] Failed to render Part 1 Q${questionNumber} page ${sourcePage}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
