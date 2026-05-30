import { prisma } from "../db.js";
import {
  extractTextFromPdfBuffer,
  bufferToBase64,
  mimeTypeFromKey,
} from "./pdfService.js";
import { getObjectBuffer } from "./s3Service.js";
import type { ExamFileType } from "./s3ObjectKey.js";
import {
  parseAnswerKeyImage,
  parseAnswerKeyText,
  parseListeningContent,
  parseReadingContent,
  type ParsedPart,
  type RcAnswerMap,
} from "./geminiService.js";

export interface ProcessingProgress {
  step: string;
  detail: string;
}

export interface UploadedFileRef {
  fileType: ExamFileType;
  s3Key: string;
  mimeType: string;
}

export interface ProcessingResult {
  totalQuestions: number;
  partsSummary: { partNumber: number; questionCount: number }[];
}

export interface ParsedToeicPayload {
  parts: ParsedPart[];
  audioS3Key?: string | null;
}

export interface ImportOptions {
  overwriteExisting?: boolean;
}

const PART_TITLES: Record<number, string> = {
  1: "Mô tả Hình ảnh",
  2: "Hỏi - Đáp",
  3: "Hội thoại",
  4: "Bài nói ngắn",
  5: "Hoàn thành Câu",
  6: "Điền vào Đoạn văn",
  7: "Đọc hiểu",
};

/**
 * Full pipeline: extract text from uploaded files, call Gemini 3 times,
 * then save all parsed data into DB with QuestionGroups.
 */
export async function processToeicExam(
  testId: string,
  files: UploadedFileRef[],
  onProgress?: (p: ProcessingProgress) => void
): Promise<ProcessingResult> {
  const log = (step: string, detail: string) => {
    console.log(`[ExamProcessing] ${step}: ${detail}`);
    onProgress?.({ step, detail });
  };

  const examPdf = files.find((f) => f.fileType === "EXAM_PDF");
  const keyLcPdf = files.find((f) => f.fileType === "KEY_LC_PDF");
  const keyRcImage = files.find((f) => f.fileType === "KEY_RC_IMAGE");
  const audioMp3 = files.find((f) => f.fileType === "AUDIO_MP3");

  if (!examPdf || !keyLcPdf || !keyRcImage) {
    throw new Error("Thiếu file bắt buộc: cần có file đề thi (PDF), KEY LC (PDF), và KEY RC (PDF).");
  }

  log("extract", "Đang trích xuất text từ file đề thi PDF...");
  const examBuffer = await getObjectBuffer(examPdf.s3Key);
  const examText = await extractTextFromPdfBuffer(examBuffer);
  const examPdfInline = bufferToBase64(
    examBuffer,
    examPdf.mimeType || mimeTypeFromKey(examPdf.s3Key, "application/pdf")
  );

  log("extract", "Đang trích xuất text từ KEY LC + Transcript PDF...");
  const transcriptBuffer = await getObjectBuffer(keyLcPdf.s3Key);
  const transcriptText = await extractTextFromPdfBuffer(transcriptBuffer);

  await prisma.uploadedFile.updateMany({
    where: { testId, fileType: "EXAM_PDF" },
    data: { extractedText: examText },
  });
  await prisma.uploadedFile.updateMany({
    where: { testId, fileType: "KEY_LC_PDF" },
    data: { extractedText: transcriptText },
  });

  log("ai_parse", "Đang đọc đáp án Reading từ KEY RC PDF...");
  const rcFileBuffer = await getObjectBuffer(keyRcImage.s3Key);
  const rcAnswers: RcAnswerMap =
    keyRcImage.mimeType === "application/pdf"
      ? await parseAnswerKeyText(await extractTextFromPdfBuffer(rcFileBuffer))
      : await parseAnswerKeyImage(
          bufferToBase64(
            rcFileBuffer,
            keyRcImage.mimeType || mimeTypeFromKey(keyRcImage.s3Key, "image/png")
          ).data,
          keyRcImage.mimeType || mimeTypeFromKey(keyRcImage.s3Key, "image/png")
        );
  log("ai_parse", `Đã đọc được ${Object.keys(rcAnswers).length} đáp án Reading.`);

  log("ai_parse", "Đang phân tích Listening (từng Part 1-4)...");
  const listeningParts: ParsedPart[] = await parseListeningContent(transcriptText, examPdfInline);
  log(
    "ai_parse",
    `Listening: ${listeningParts.length} parts, ${listeningParts.reduce((n, p) => n + p.groups.reduce((g, gr) => g + gr.questions.length, 0), 0)} câu.`
  );

  log("ai_parse", "Đang phân tích Reading (từng Part 5-7)...");
  const readingParts: ParsedPart[] = await parseReadingContent(examText, rcAnswers, examPdfInline);
  log(
    "ai_parse",
    `Reading: ${readingParts.length} parts, ${readingParts.reduce((n, p) => n + p.groups.reduce((g, gr) => g + gr.questions.length, 0), 0)} câu.`
  );

  log("save_db", "Đang lưu dữ liệu vào cơ sở dữ liệu...");
  const allParts = [...listeningParts, ...readingParts];
  const result = await importParsedToeicData(
    testId,
    { parts: allParts, audioS3Key: audioMp3?.s3Key ?? null },
    { overwriteExisting: true }
  );

  log("done", `Hoàn tất! Tổng cộng ${result.totalQuestions} câu hỏi đã được import.`);
  return result;
}

export function validateToeicStructure(parts: ParsedPart[]): void {
  if (!parts.length) {
    throw new Error("Không tìm thấy dữ liệu Part nào để import.");
  }

  const questionNumbers: number[] = [];
  const expectedPerPart: Record<number, number> = {
    1: 6,
    2: 25,
    3: 39,
    4: 30,
    5: 30,
    6: 16,
    7: 54,
  };
  const actualPerPart: Record<number, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
  };
  for (const part of parts) {
    if (part.partNumber < 1 || part.partNumber > 7) {
      throw new Error(`Part không hợp lệ: ${part.partNumber}.`);
    }
    for (const group of part.groups) {
      for (const q of group.questions) {
        if (!q.questionText?.trim()) {
          throw new Error(`Part ${part.partNumber} có câu hỏi thiếu nội dung.`);
        }
        if (!q.options?.length) {
          throw new Error(`Part ${part.partNumber} câu ${q.questionNumber} thiếu đáp án lựa chọn.`);
        }
        if (part.partNumber === 2) {
          if (q.options.length < 3 || q.options.length > 4) {
            throw new Error(`Part 2 câu ${q.questionNumber} phải có 3-4 lựa chọn.`);
          }
        } else if (q.options.length < 4) {
          throw new Error(`Part ${part.partNumber} câu ${q.questionNumber} phải có ít nhất 4 lựa chọn.`);
        }
        questionNumbers.push(q.questionNumber);
        actualPerPart[part.partNumber] = (actualPerPart[part.partNumber] || 0) + 1;
      }
    }
  }

  const minQ = Math.min(...questionNumbers);
  const maxQ = Math.max(...questionNumbers);
  if (minQ < 1 || maxQ > 200) {
    throw new Error(`Số thứ tự câu hỏi ngoài phạm vi TOEIC (1-200): min=${minQ}, max=${maxQ}.`);
  }

  const unique = new Set(questionNumbers);
  if (unique.size !== questionNumbers.length) {
    throw new Error("Có câu hỏi bị trùng questionNumber sau khi parse AI.");
  }
  if (unique.size !== 200) {
    throw new Error(`Tổng số câu parse được không đủ 200 (hiện tại: ${unique.size}).`);
  }
  for (let i = 1; i <= 200; i++) {
    if (!unique.has(i)) {
      throw new Error(`Thiếu câu số ${i} trong dữ liệu parse.`);
    }
  }
  for (const partNum of Object.keys(expectedPerPart).map(Number)) {
    const expected = expectedPerPart[partNum]!;
    const actual = actualPerPart[partNum] || 0;
    if (actual !== expected) {
      throw new Error(`Part ${partNum} không đúng số câu: expected=${expected}, actual=${actual}.`);
    }
  }
}

export async function importParsedToeicData(
  testId: string,
  payload: ParsedToeicPayload,
  options: ImportOptions = {}
): Promise<ProcessingResult> {
  const overwriteExisting = options.overwriteExisting ?? false;
  validateToeicStructure(payload.parts);

  return prisma.$transaction(async (tx) => {
    const partNumbers = [...new Set(payload.parts.map((p) => p.partNumber))];

    if (overwriteExisting) {
      const existingParts = await tx.testPart.findMany({
        where: { testId, partNumber: { in: partNumbers } },
        select: { id: true },
      });
      const existingPartIds = existingParts.map((p) => p.id);
      if (existingPartIds.length) {
        await tx.questionGroup.deleteMany({ where: { testPartId: { in: existingPartIds } } });
        await tx.question.deleteMany({ where: { testPartId: { in: existingPartIds } } });
      }
    }

    const partsSummary: { partNumber: number; questionCount: number }[] = [];
    let totalQuestions = 0;

    for (const parsedPart of payload.parts) {
      const partNum = parsedPart.partNumber;

      let testPart = await tx.testPart.findFirst({
        where: { testId, partNumber: partNum },
      });

      if (!testPart) {
        testPart = await tx.testPart.create({
          data: {
            testId,
            partNumber: partNum,
            title: `Part ${partNum}: ${PART_TITLES[partNum] || "TOEIC"}`,
            instructions: `Luyện tập Part ${partNum}`,
            audioUrl: partNum <= 4 ? payload.audioS3Key || null : null,
          },
        });
      } else if (partNum <= 4 && payload.audioS3Key) {
        testPart = await tx.testPart.update({
          where: { id: testPart.id },
          data: { audioUrl: payload.audioS3Key },
        });
      }

      let partQuestionCount = 0;

      for (let gIdx = 0; gIdx < parsedPart.groups.length; gIdx++) {
        const group = parsedPart.groups[gIdx]!;

        const dbGroup = await tx.questionGroup.create({
          data: {
            testPartId: testPart.id,
            passage: group.passage || null,
            transcript: group.transcript || null,
            groupOrder: gIdx,
          },
        });

        for (const q of group.questions) {
          const dbQuestion = await tx.question.create({
            data: {
              testPartId: testPart.id,
              questionGroupId: dbGroup.id,
              questionNumber: q.questionNumber,
              questionText: q.questionText,
              correctAnswer: q.correctAnswer?.toUpperCase() || "A",
              passage: group.passage || null,
              transcript: group.transcript || null,
            },
          });

          const optionsForQuestion = q.options?.length
            ? q.options
            : [
                { letter: "A", text: "Option A" },
                { letter: "B", text: "Option B" },
                { letter: "C", text: "Option C" },
                { letter: "D", text: "Option D" },
              ];

          for (const opt of optionsForQuestion) {
            await tx.option.create({
              data: {
                questionId: dbQuestion.id,
                letter: opt.letter.toUpperCase(),
                text: opt.text,
              },
            });
          }

          partQuestionCount++;
          totalQuestions++;
        }
      }

      partsSummary.push({ partNumber: partNum, questionCount: partQuestionCount });
    }

    return { totalQuestions, partsSummary };
  });
}
