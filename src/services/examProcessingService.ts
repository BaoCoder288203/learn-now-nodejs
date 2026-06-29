import { prisma } from "../db.js";
import { extractDocumentText } from "./documentExtractService.js";
import {
  bufferToBase64,
  mimeTypeFromKey,
} from "./pdfService.js";
import { getObjectBuffer } from "./s3Service.js";
import type { ExamFileType } from "./s3ObjectKey.js";
import type { NormalizedBbox, ParsedGroup } from "./ai/types.js";
import {
  detectGroupImageBbox,
  extractTextRegionsFromImage,
  parseAnswerKeyImage,
  parseAnswerKeyText,
  parseListeningPart,
  parseReadingPart,
  type ParsedPart,
  type PdfInlineData,
  type RcAnswerMap,
  type TextRegion,
} from "./toeicAiService.js";
import {
  clampBbox,
  cropPngBuffer,
  filterRegionsInsideBbox,
  remapRegionsToCrop,
} from "./imageCropService.js";
import type { PipelineStateV1, PipelineStepId } from "./importPipelineState.js";
import {
  createEmptyPipelineState,
  resetIncompleteParseSteps,
  type ExtractTextsResult,
} from "./importPipelineState.js";
import { getAiStepForResume, runPipelineStep } from "./importPipelineRunner.js";
import { savePipelineState } from "./importPipelinePersistence.js";
import {
  persistExtractedText,
  syncUploadedFilesFromRefs,
} from "./uploadedFileSyncService.js";
import { normalizeParsedPart, normalizeParsedParts } from "./normalizeParsedToeic.js";
import {
  getPdfPageCount,
  renderPdfPage,
  uploadPart1QuestionImage,
  uploadPassageGroupImage,
} from "./pdfImageService.js";
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

export interface PreparedGroupAssetsSerializable {
  imageUrl?: string | null;
  textRegions?: TextRegion[] | null;
  questionImages: Record<number, string>;
}

export interface ImportOptions {
  overwriteExisting?: boolean;
  examPdfBuffer?: Buffer;
  examType?: string;
  /** Pre-built assets from save_assets (PyMuPDF pipeline). Skips prepareImportAssets when set. */
  preparedAssetsOverride?: Map<string, PreparedGroupAssets>;
}

interface PreparedGroupAssets {
  imageUrl?: string | null;
  textRegions?: TextRegion[] | null;
  questionImages: Map<number, string>;
}

export function serializePreparedAssets(
  assets: Map<string, PreparedGroupAssets>
): Record<string, PreparedGroupAssetsSerializable> {
  const out: Record<string, PreparedGroupAssetsSerializable> = {};
  for (const [key, entry] of assets) {
    out[key] = {
      imageUrl: entry.imageUrl,
      textRegions: entry.textRegions,
      questionImages: Object.fromEntries(entry.questionImages),
    };
  }
  return out;
}

export function deserializePreparedAssets(
  raw: Record<string, PreparedGroupAssetsSerializable> | undefined
): Map<string, PreparedGroupAssets> | undefined {
  if (!raw) return undefined;
  const map = new Map<string, PreparedGroupAssets>();
  for (const [key, entry] of Object.entries(raw)) {
    map.set(key, {
      imageUrl: entry.imageUrl,
      textRegions: entry.textRegions,
      questionImages: new Map(Object.entries(entry.questionImages).map(([k, v]) => [Number(k), v])),
    });
  }
  return map;
}

export interface ProcessToeicExamContext {
  jobId?: string;
  pipelineState?: PipelineStateV1;
  source?: PipelineStateV1["source"];
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

function groupAssetKey(partNumber: number, groupIndex: number): string {
  return `${partNumber}-${groupIndex}`;
}

interface PageCacheEntry {
  png: Buffer;
  /** Full-page text regions (Part 6/7). Scanned before any crop. */
  pageRegions: TextRegion[] | null;
  scanAttempted: boolean;
}

async function resolveGroupImageBbox(
  group: ParsedGroup,
  partNum: number,
  pagePng: Buffer
): Promise<NormalizedBbox | null> {
  const fromParse = group.imageBbox ? clampBbox(group.imageBbox) : null;
  if (fromParse) return fromParse;

  const questionNumbers = group.questions.map((q) => q.questionNumber);
  if (!questionNumbers.length) return null;

  try {
    const inline = bufferToBase64(pagePng, "image/png");
    return await detectGroupImageBbox(inline.data, inline.mimeType, {
      partNumber: partNum,
      questionNumbers,
      passageSnippet: group.passage,
    });
  } catch (error) {
    console.warn(
      `[ExamProcessing] detectGroupImageBbox failed Part ${partNum} Q${questionNumbers.join(",")}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

async function prepareImportAssets(
  testId: string,
  examType: string,
  examPdfBuffer: Buffer | undefined,
  parts: ParsedPart[]
): Promise<Map<string, PreparedGroupAssets>> {
  const assets = new Map<string, PreparedGroupAssets>();

  if (!examPdfBuffer) {
    return assets;
  }

  let maxPages = 0;
  try {
    maxPages = await getPdfPageCount(examPdfBuffer);
  } catch (error) {
    console.warn(
      "[ExamProcessing] Cannot read PDF page count for image pipeline:",
      error instanceof Error ? error.message : error
    );
    return assets;
  }

  const pageCache = new Map<number, PageCacheEntry>();

  async function getPagePng(sourcePage: number): Promise<Buffer | null> {
    if (sourcePage < 1 || sourcePage > maxPages) return null;
    const cached = pageCache.get(sourcePage);
    if (cached) return cached.png;
    try {
      const png = await renderPdfPage(examPdfBuffer!, sourcePage);
      pageCache.set(sourcePage, { png, pageRegions: null, scanAttempted: false });
      return png;
    } catch (error) {
      console.warn(
        `[ExamProcessing] renderPdfPage ${sourcePage} failed:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  /** Part 6/7: scan all clickable words on full page before cropping. */
  async function getPageTextRegions(sourcePage: number, pagePng: Buffer): Promise<TextRegion[]> {
    let entry = pageCache.get(sourcePage);
    if (!entry) {
      entry = { png: pagePng, pageRegions: null, scanAttempted: false };
      pageCache.set(sourcePage, entry);
    }
    if (entry.scanAttempted) {
      return entry.pageRegions ?? [];
    }
    entry.scanAttempted = true;
    try {
      const inline = bufferToBase64(pagePng, "image/png");
      entry.pageRegions = await extractTextRegionsFromImage(inline.data, inline.mimeType);
    } catch (error) {
      console.warn(
        `[ExamProcessing] extractTextRegionsFromImage page ${sourcePage} failed:`,
        error instanceof Error ? error.message : error
      );
      entry.pageRegions = null;
    }
    return entry.pageRegions ?? [];
  }

  for (const parsedPart of parts) {
    const partNum = parsedPart.partNumber;
    const needsCrop = partNum === 1 || partNum === 6 || partNum === 7;
    if (!needsCrop) continue;

    for (let gIdx = 0; gIdx < parsedPart.groups.length; gIdx++) {
      const group = parsedPart.groups[gIdx]!;
      const key = groupAssetKey(partNum, gIdx);
      const entry: PreparedGroupAssets = { questionImages: new Map() };
      assets.set(key, entry);

      const sourcePage = group.sourcePage;
      if (!sourcePage) continue;

      const pagePng = await getPagePng(sourcePage);
      if (!pagePng) continue;

      try {
        if (partNum === 1) {
          const question = group.questions[0];
          if (!question) continue;

          const bbox = await resolveGroupImageBbox(group, partNum, pagePng);
          if (!bbox) continue;

          const cropped = await cropPngBuffer(pagePng, bbox);
          const imageKey = await uploadPart1QuestionImage(
            examType,
            testId,
            question.questionNumber,
            cropped
          );
          entry.questionImages.set(question.questionNumber, imageKey);
          continue;
        }

        if (partNum === 6 || partNum === 7) {
          // 1) Scan full page text regions before crop
          const pageRegions = await getPageTextRegions(sourcePage, pagePng);

          // 2) Resolve passage/photo bbox
          const bbox = await resolveGroupImageBbox(group, partNum, pagePng);
          if (!bbox) continue;

          // 3) Crop passage image for S3
          const cropped = await cropPngBuffer(pagePng, bbox);

          // 4) Remap regions to cropped image coordinates
          const filtered = filterRegionsInsideBbox(pageRegions, bbox);
          let textRegions = remapRegionsToCrop(filtered, bbox);

          if (!textRegions.length) {
            console.warn(
              `[ExamProcessing] No remapped textRegions Part ${partNum} group ${gIdx}; fallback scan on cropped image.`
            );
            try {
              const croppedInline = bufferToBase64(cropped, "image/png");
              textRegions = await extractTextRegionsFromImage(
                croppedInline.data,
                croppedInline.mimeType
              );
            } catch (fallbackErr) {
              console.warn(
                `[ExamProcessing] Cropped textRegions fallback failed:`,
                fallbackErr instanceof Error ? fallbackErr.message : fallbackErr
              );
            }
          }

          entry.imageUrl = await uploadPassageGroupImage(
            examType,
            testId,
            partNum,
            gIdx,
            cropped
          );
          entry.textRegions = textRegions.length ? textRegions : null;
        }
      } catch (error) {
        console.warn(
          `[ExamProcessing] Image pipeline failed Part ${partNum} group ${gIdx}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  return assets;
}

async function resolveExamTranscriptTexts(
  testId: string,
  examPdf: UploadedFileRef,
  keyLcPdf: UploadedFileRef,
  log: (step: string, detail: string) => void
): Promise<{
  examText: string;
  transcriptText: string;
  examBuffer: Buffer;
  examMime: string;
}> {
  const examBuffer = await getObjectBuffer(examPdf.s3Key);
  const examMime = examPdf.mimeType || mimeTypeFromKey(examPdf.s3Key, "application/pdf");

  let examRow = await prisma.uploadedFile.findFirst({
    where: { testId, fileType: "EXAM_PDF" },
    select: { extractedText: true },
  });
  let transcriptRow = await prisma.uploadedFile.findFirst({
    where: { testId, fileType: "KEY_LC_PDF" },
    select: { extractedText: true },
  });

  let examText = examRow?.extractedText?.trim() ?? "";
  let transcriptText = transcriptRow?.extractedText?.trim() ?? "";

  if (!examText || !transcriptText) {
    log("extract", "Thiếu text trong DB — trích xuất lại từ S3...");
    if (!examText) {
      examText = (
        await extractDocumentText(examBuffer, examMime, "exam.pdf")
      ).trim();
      await persistExtractedText(testId, "EXAM_PDF", examText);
    }
    if (!transcriptText) {
      const transcriptBuffer = await getObjectBuffer(keyLcPdf.s3Key);
      const transcriptMime =
        keyLcPdf.mimeType || mimeTypeFromKey(keyLcPdf.s3Key, "application/pdf");
      transcriptText = (
        await extractDocumentText(transcriptBuffer, transcriptMime, "key-lc.pdf")
      ).trim();
      await persistExtractedText(testId, "KEY_LC_PDF", transcriptText);
    }
  }

  if (!examText) {
    throw new Error(
      "Không trích được text từ file đề thi (EXAM_PDF). Kiểm tra PDF scan/ảnh hoặc MarkItDown."
    );
  }
  if (!transcriptText) {
    throw new Error(
      "Không trích được text từ KEY LC + Transcript. Kiểm tra PDF hoặc bật MARKITDOWN_URL."
    );
  }

  return { examText, transcriptText, examBuffer, examMime };
}

/**
 * Resumable pipeline: checkpoint each step in pipelineState (persisted via job draft).
 */
export async function processToeicExamResumable(
  testId: string,
  files: UploadedFileRef[],
  onProgress?: (p: ProcessingProgress) => void,
  ctx?: ProcessToeicExamContext
): Promise<ProcessingResult> {
  const { usePyMuPdfPipeline } = await import("./pymupdfClient.js");
  if (usePyMuPdfPipeline()) {
    const { processToeicExamPyMuPdfResumable } = await import("./pymupdfExamPipeline.js");
    return processToeicExamPyMuPdfResumable(testId, files, onProgress, ctx);
  }

  const log = (step: string, detail: string) => {
    console.log(`[ExamProcessing] ${step}: ${detail}`);
    onProgress?.({ step, detail });
  };

  const test = await prisma.test.findUnique({
    where: { id: testId },
    select: { examType: true },
  });
  if (!test) {
    throw new Error("Không tìm thấy đề thi.");
  }

  const examPdf = files.find((f) => f.fileType === "EXAM_PDF");
  const keyLcPdf = files.find((f) => f.fileType === "KEY_LC_PDF");
  const keyRcImage = files.find((f) => f.fileType === "KEY_RC_IMAGE");
  const audioMp3 = files.find((f) => f.fileType === "AUDIO_MP3");

  if (!examPdf || !keyLcPdf || !keyRcImage) {
    throw new Error("Thiếu file bắt buộc: cần có file đề thi (PDF), KEY LC (PDF), và KEY RC (PDF).");
  }

  await syncUploadedFilesFromRefs(testId, files);

  const pipelineState =
    ctx?.pipelineState ?? createEmptyPipelineState(testId, {
      jobId: ctx?.jobId,
      source: ctx?.source ?? (ctx?.jobId ? "import_job" : "direct_import"),
    });

  const checkpoint = async (state: PipelineStateV1, stepId: PipelineStepId) => {
    if (ctx?.jobId) {
      await savePipelineState(ctx.jobId, state, `Pipeline: ${stepId}`);
    }
  };

  const stepOpts = { onCheckpoint: checkpoint };

  const resetSteps = resetIncompleteParseSteps(pipelineState);
  if (resetSteps.length) {
    log(
      "resume",
      `Checkpoint thiếu/sai số câu — reset steps: ${resetSteps.join(", ")}`
    );
    await checkpoint(pipelineState, "save_db");
  }

  await runPipelineStep(
    pipelineState,
    "extract_texts",
    async () => {
      log("extract", "Đang trích xuất text từ file đề thi PDF...");
      const examBuffer = await getObjectBuffer(examPdf.s3Key);
      const examMime = examPdf.mimeType || mimeTypeFromKey(examPdf.s3Key, "application/pdf");
      const examText = await extractDocumentText(examBuffer, examMime, "exam.pdf");

      log("extract", "Đang trích xuất text từ KEY LC + Transcript PDF...");
      const transcriptBuffer = await getObjectBuffer(keyLcPdf.s3Key);
      const transcriptMime =
        keyLcPdf.mimeType || mimeTypeFromKey(keyLcPdf.s3Key, "application/pdf");
      const transcriptText = await extractDocumentText(
        transcriptBuffer,
        transcriptMime,
        "key-lc.pdf"
      );

      await persistExtractedText(testId, "EXAM_PDF", examText);
      await persistExtractedText(testId, "KEY_LC_PDF", transcriptText);

      return {
        examTextLength: examText.length,
        transcriptTextLength: transcriptText.length,
      } satisfies ExtractTextsResult;
    },
    stepOpts
  );

  const { examText, transcriptText, examBuffer, examMime } = await resolveExamTranscriptTexts(
    testId,
    examPdf,
    keyLcPdf,
    log
  );
  const examPdfInline = bufferToBase64(examBuffer, examMime) as PdfInlineData;

  const rcAnswers = await runPipelineStep(
    pipelineState,
    "parse_rc_answers",
    async () => {
      log("ai_parse", "Đang đọc đáp án Reading từ KEY RC PDF...");
      const rcFileBuffer = await getObjectBuffer(keyRcImage.s3Key);
      const rcMime = keyRcImage.mimeType || mimeTypeFromKey(keyRcImage.s3Key, "image/png");
      const answers: RcAnswerMap =
        keyRcImage.mimeType === "application/pdf"
          ? await parseAnswerKeyText(
              await extractDocumentText(rcFileBuffer, rcMime, "key-rc.pdf"),
              getAiStepForResume(pipelineState, "parse_rc_answers")
            )
          : await parseAnswerKeyImage(
              bufferToBase64(rcFileBuffer, rcMime).data,
              rcMime,
              getAiStepForResume(pipelineState, "parse_rc_answers")
            );
      log("ai_parse", `Đã đọc được ${Object.keys(answers).length} đáp án Reading.`);
      return answers;
    },
    stepOpts
  );

  const listeningParts: ParsedPart[] = [];
  for (const partNumber of [1, 2, 3, 4] as const) {
    const stepId = `parse_listening_${partNumber}` as PipelineStepId;
    log("ai_parse", `Đang phân tích Listening Part ${partNumber}...`);
    const part = await runPipelineStep(
      pipelineState,
      stepId,
      () =>
        parseListeningPart(
          transcriptText,
          partNumber,
          examPdfInline,
          getAiStepForResume(pipelineState, stepId)
        ),
      stepOpts
    );
    listeningParts.push(normalizeParsedPart(part, partNumber));
  }

  const readingParts: ParsedPart[] = [];
  for (const partNumber of [5, 6, 7] as const) {
    const stepId = `parse_reading_${partNumber}` as PipelineStepId;
    log("ai_parse", `Đang phân tích Reading Part ${partNumber}...`);
    const part = await runPipelineStep(
      pipelineState,
      stepId,
      () =>
        parseReadingPart(
          examText,
          rcAnswers,
          partNumber,
          examPdfInline,
          getAiStepForResume(pipelineState, stepId)
        ),
      stepOpts
    );
    readingParts.push(normalizeParsedPart(part, partNumber));
  }

  const allParts = normalizeParsedParts([...listeningParts, ...readingParts]);

  const result = await runPipelineStep(
    pipelineState,
    "save_db",
    async () => {
      log("save_db", "Đang render ảnh PDF, lưu câu hỏi vào cơ sở dữ liệu...");
      return importParsedToeicData(
        testId,
        { parts: allParts, audioS3Key: audioMp3?.s3Key ?? null },
        {
          overwriteExisting: true,
          examPdfBuffer: examBuffer,
          examType: test.examType,
        }
      );
    },
    stepOpts
  );

  log("done", `Hoàn tất! Tổng cộng ${result.totalQuestions} câu hỏi đã được import.`);
  return result;
}

/**
 * Full pipeline: extract text, AI per part (checkpointed when jobId provided),
 * save to DB (includes PDF image render + S3 upload via prepareImportAssets).
 */
export async function processToeicExam(
  testId: string,
  files: UploadedFileRef[],
  onProgress?: (p: ProcessingProgress) => void,
  ctx?: ProcessToeicExamContext
): Promise<ProcessingResult> {
  return processToeicExamResumable(testId, files, onProgress, ctx);
}

export function validateToeicStructure(parts: ParsedPart[]): void {
  if (!parts.length) {
    throw new Error("Không tìm thấy dữ liệu Part nào để import.");
  }

  for (const part of parts) {
    if (!Array.isArray(part.groups)) {
      throw new Error(`Part ${part.partNumber}: thiếu mảng groups.`);
    }
    for (let gi = 0; gi < part.groups.length; gi++) {
      const group = part.groups[gi]!;
      if (!Array.isArray(group.questions)) {
        throw new Error(
          `Part ${part.partNumber} group ${gi}: questions phải là mảng (nhận ${typeof group.questions}).`
        );
      }
    }
  }

  const questionNumbers: number[] = [];
  const expectedPerPart = EXPECTED_QUESTIONS_PER_PART;
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
  if (unique.size < 185) {
    throw new Error(`Tổng số câu parse được không đủ 185 (hiện tại: ${unique.size}).`);
  }
  if (unique.size < 200) {
    console.warn(`[TOEIC import] Partial parse: ${unique.size}/200 questions — importing available items.`);
  }
  if (unique.size >= 200) {
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
}

export async function importParsedToeicData(
  testId: string,
  payload: ParsedToeicPayload,
  options: ImportOptions = {}
): Promise<ProcessingResult> {
  const overwriteExisting = options.overwriteExisting ?? false;
  const parts = normalizeParsedParts(payload.parts);
  validateToeicStructure(parts);

  let examType = options.examType;
  if (!examType) {
    const test = await prisma.test.findUnique({
      where: { id: testId },
      select: { examType: true },
    });
    examType = test?.examType || "TOEIC";
  }

  const preparedAssets =
    options.preparedAssetsOverride ??
    (await prepareImportAssets(testId, examType, options.examPdfBuffer, parts));

  return prisma.$transaction(async (tx) => {
    const partNumbers = [...new Set(parts.map((p) => p.partNumber))];

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

    for (const parsedPart of parts) {
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
        const assetKey = groupAssetKey(partNum, gIdx);
        const assets = preparedAssets.get(assetKey);

        const dbGroup = await tx.questionGroup.create({
          data: {
            testPartId: testPart.id,
            passage: group.passage || null,
            transcript: group.transcript || null,
            imageUrl: assets?.imageUrl || null,
            textRegions: assets?.textRegions ? (assets.textRegions as object) : undefined,
            groupOrder: gIdx,
          },
        });

        const groupImages =
          assets?.images?.length
            ? assets.images
            : assets?.imageUrl
              ? [
                  {
                    imageUrl: assets.imageUrl,
                    textRegions: assets.textRegions,
                    sourcePage: group.sourcePage ?? group.sourcePages?.[0] ?? null,
                  },
                ]
              : [];

        if (groupImages.length) {
          await tx.questionGroupImage.createMany({
            data: groupImages.map((image, order) => ({
              questionGroupId: dbGroup.id,
              order,
              imageUrl: image.imageUrl,
              textRegions: image.textRegions ? (image.textRegions as object) : undefined,
              sourcePage: image.sourcePage ?? null,
            })),
          });
        }

        for (const q of group.questions) {
          const questionImage = assets?.questionImages.get(q.questionNumber) || null;

          const dbQuestion = await tx.question.create({
            data: {
              testPartId: testPart.id,
              questionGroupId: dbGroup.id,
              questionNumber: q.questionNumber,
              questionText: q.questionText,
              correctAnswer: q.correctAnswer?.toUpperCase() || "A",
              passage: group.passage || null,
              transcript: group.transcript || null,
              image: questionImage,
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

          emitImportLog(
            options,
            `Part ${partNum} Q${q.questionNumber}: import OK — ${questionTextCharCount(q.questionText)} chữ`
          );
        }
      }

      const expected = EXPECTED_QUESTIONS_PER_PART[partNum];
      const partStatus =
        expected != null && partQuestionCount === expected
          ? "đủ"
          : expected != null
            ? `${partQuestionCount}/${expected}`
            : String(partQuestionCount);
      emitImportLog(
        options,
        `Part ${partNum}: ${partQuestionCount} câu import thành công (${partStatus})`
      );

      partsSummary.push({ partNumber: partNum, questionCount: partQuestionCount });
    }

    emitImportLog(
      options,
      `Tổng kết: ${totalQuestions} câu — ${partsSummary.map((p) => `P${p.partNumber}=${p.questionCount}`).join(", ")}`
    );

    return { totalQuestions, partsSummary };
  });
}
