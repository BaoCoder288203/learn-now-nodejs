import path from "path";

export type ExamFileType = "EXAM_PDF" | "KEY_LC_PDF" | "KEY_RC_IMAGE" | "AUDIO_MP3";

export type ExamSlug = "toeic" | "ielts";

export function examSlug(examType: string): ExamSlug {
  const normalized = examType.trim().toUpperCase();
  if (normalized === "TOEIC") return "toeic";
  if (normalized === "IELTS") return "ielts";
  throw new Error(`examType không hỗ trợ: ${examType}`);
}

function normalizeExt(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (!trimmed.startsWith(".")) {
    throw new Error(`Phần mở rộng file phải bắt đầu bằng dấu chấm, nhận được: ${ext}`);
  }
  return trimmed;
}

/** Raw upload path before role classification (multi-file intake). */
export function buildIntakeObjectKey(
  examType: string,
  testId: string,
  originalName: string
): string {
  const exam = examSlug(examType);
  const ext = path.extname(originalName) || ".bin";
  const baseName =
    path.basename(originalName, ext).replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
  return `intake/${exam}/${testId}/${Date.now()}-${baseName}${ext}`;
}

export function buildObjectKey(
  examType: string,
  testId: string,
  fileType: ExamFileType,
  ext: string
): string {
  const exam = examSlug(examType);
  const normalizedExt = normalizeExt(ext);

  switch (fileType) {
    case "EXAM_PDF":
      return `exams/${exam}/${testId}/exam${normalizedExt}`;
    case "KEY_LC_PDF":
      return `answers/${exam}/${testId}/key-lc${normalizedExt}`;
    case "KEY_RC_IMAGE":
      return `images/${exam}/${testId}/key-rc${normalizedExt}`;
    case "AUDIO_MP3":
      return `audio/${exam}/${testId}/listening${normalizedExt}`;
    default:
      throw new Error(`fileType không hỗ trợ: ${fileType}`);
  }
}

/** Passage/photograph image rendered from exam PDF during import. */
export function buildPassageGroupImageKey(
  examType: string,
  testId: string,
  partNumber: number,
  groupOrder: number
): string {
  const exam = examSlug(examType);
  return `passages/${exam}/${testId}/part-${partNumber}/group-${groupOrder}.png`;
}

/** Full reading page rendered from exam PDF (Part 5–7). */
export function buildReadingPageImageKey(
  examType: string,
  testId: string,
  partNumber: number,
  sourcePage: number
): string {
  const exam = examSlug(examType);
  return `passages/${exam}/${testId}/part-${partNumber}/page-${sourcePage}.png`;
}

/** Part 1 photograph per question. */
export function buildPart1QuestionImageKey(
  examType: string,
  testId: string,
  questionNumber: number
): string {
  const exam = examSlug(examType);
  return `passages/${exam}/${testId}/part-1/q-${questionNumber}.png`;
}
