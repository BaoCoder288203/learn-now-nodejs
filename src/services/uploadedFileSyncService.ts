import { prisma } from "../db.js";
import type { UploadedFileRef } from "./examProcessingService.js";
import type { ExamFileType } from "./s3ObjectKey.js";

/**
 * Import-jobs only create IngestionFile rows; TOEIC pipeline expects UploadedFile.
 * Upsert one row per fileType so extract can persist extractedText.
 */
export async function syncUploadedFilesFromRefs(
  testId: string,
  refs: UploadedFileRef[],
  fileNames: Partial<Record<ExamFileType, string>> = {}
): Promise<void> {
  for (const ref of refs) {
    const fileName = fileNames[ref.fileType] ?? ref.fileType;
    const existing = await prisma.uploadedFile.findFirst({
      where: { testId, fileType: ref.fileType },
    });

    if (existing) {
      await prisma.uploadedFile.update({
        where: { id: existing.id },
        data: {
          filePath: ref.s3Key,
          mimeType: ref.mimeType,
          fileName,
        },
      });
    } else {
      await prisma.uploadedFile.create({
        data: {
          testId,
          fileType: ref.fileType,
          fileName,
          filePath: ref.s3Key,
          mimeType: ref.mimeType,
        },
      });
    }
  }
}

export async function persistExtractedText(
  testId: string,
  fileType: ExamFileType,
  extractedText: string
): Promise<void> {
  const updated = await prisma.uploadedFile.updateMany({
    where: { testId, fileType },
    data: { extractedText },
  });

  if (updated.count === 0) {
    throw new Error(
      `Không tìm thấy UploadedFile (${fileType}) cho test ${testId}. Gọi syncUploadedFilesFromRefs trước.`
    );
  }
}
