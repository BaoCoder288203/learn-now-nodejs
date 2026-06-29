import { prisma } from "../db.js";
import { extractDocumentText } from "./documentExtractService.js";
import { mimeTypeFromKey } from "./pdfService.js";
import { getObjectBuffer } from "./s3Service.js";
import type { ExamFileType } from "./s3ObjectKey.js";
import type { ParsedPart, RcAnswerMap } from "./toeicAiService.js";
import { parseAnswerKeyImage, parseAnswerKeyText } from "./toeicAiService.js";
import { bufferToBase64 } from "./pdfService.js";
import type { PipelineStateV1, PipelineStepId } from "./importPipelineState.js";
import {
  createEmptyPipelineStateV2,
  getStepState,
  isV2PipelineState,
  setStepDone,
  type ExtractTextsResult,
} from "./importPipelineState.js";
import { getAiStepForResume, runPipelineStep, type RunStepOptions } from "./importPipelineRunner.js";
import { savePipelineState } from "./importPipelinePersistence.js";
import {
  persistExtractedText,
  syncUploadedFilesFromRefs,
} from "./uploadedFileSyncService.js";
import { normalizeParsedPart, normalizeParsedParts } from "./normalizeParsedToeic.js";
import {
  pymupdfExtractLayout,
  pymupdfExtractText,
  pymupdfClipPage,
  pymupdfRenderPage,
  spansToTextRegions,
  usePyMuPdfPipeline,
  type PyMuPdfDocumentLayout,
} from "./pymupdfClient.js";
import {
  PART7_CHUNK_RANGES,
  PART7_NORMALIZE_CHUNK_STEP_IDS,
  parseKeyRcFromText,
  parseReadingPart5,
  parseReadingPart6,
  parseReadingPart7Chunk,
  parseListeningParts,
  attachPart1Images,
  attachListeningGroupVisuals,
  repairListeningQuestionsFromLayout,
  sliceRawPartByQuestionRange,
  type RawToeicDocument,
  type RawToeicPart,
  type PyMuPdfExtractResult,
} from "./toeicRuleParser/index.js";
import { convertRawPartToParsed } from "./geminiNormalizeService.js";
import {
  deserializePreparedAssets,
  importParsedToeicData,
  serializePreparedAssets,
  type PreparedGroupAssetsSerializable,
  type ProcessingProgress,
  type ProcessingResult,
  type ProcessToeicExamContext,
  type UploadedFileRef,
} from "./examProcessingService.js";
import { uploadPart1QuestionImage, uploadPassageGroupImage, uploadReadingPageImage } from "./pdfImageService.js";
import type { NormalizedBbox, TextRegion } from "./ai/types.js";
import { clampBbox } from "./imageCropBbox.js";
import { filterRegionsInsideBbox, remapRegionsToCrop } from "./imageCropBbox.js";
import { findPassageBboxOnPage, findPageForPassageHeader } from "./toeicRuleParser/layoutBbox.js";
import { isFullPageBbox } from "./toeicRuleParser/columnLayout.js";
import { summarizeReadingParse } from "./toeicRuleParser/readingParseSummary.js";

interface ReadingParseProgress {
  part5?: RawToeicPart;
  part6?: RawToeicPart;
  part7Groups: RawToeicPart["groups"];
  completedChunks: string[];
}

function chunkKey(start: number, end: number): string {
  return `${start}_${end}`;
}

async function normalizeRawPart(
  raw: RawToeicPart,
  pipelineState: PipelineStateV1,
  stepOpts?: RunStepOptions,
  log?: (step: string, detail: string) => void
): Promise<ParsedPart> {
  const normStepId = `gemini_normalize_${raw.partNumber}` as PipelineStepId;
  return runPipelineStep(
    pipelineState,
    normStepId,
    async () => {
      log?.("gemini_normalize", `Part ${raw.partNumber}: rule-parsed structure (skip AI reshape).`);
      return convertRawPartToParsed(raw);
    },
    stepOpts
  );
}

async function resolveRcAnswers(
  keyRcImage: UploadedFileRef,
  keyRcText: string,
  pipelineState: PipelineStateV1
): Promise<RcAnswerMap> {
  const ruleParsed = parseKeyRcFromText(keyRcText);
  if (Object.keys(ruleParsed).length >= 80) {
    return ruleParsed;
  }

  const rcFileBuffer = await getObjectBuffer(keyRcImage.s3Key);
  const rcMime = keyRcImage.mimeType || mimeTypeFromKey(keyRcImage.s3Key, "image/png");

  if (keyRcImage.mimeType === "application/pdf") {
    const text =
      keyRcText || (await pymupdfExtractText(rcFileBuffer, "key-rc.pdf"));
    const fromText = parseKeyRcFromText(text);
    if (Object.keys(fromText).length >= 50) return fromText;
    return parseAnswerKeyText(text, getAiStepForResume(pipelineState, "parse_rc_key"));
  }

  return parseAnswerKeyImage(
    bufferToBase64(rcFileBuffer, rcMime).data,
    rcMime,
    getAiStepForResume(pipelineState, "parse_rc_key")
  );
}

function resolveGroupBbox(
  parsedPart: ParsedPart,
  group: ParsedPart["groups"][0],
  pageLayoutCache: Map<number, PyMuPdfDocumentLayout["pages"][0]>
): NormalizedBbox | undefined {
  const fromGroup = group.imageBbox ? clampBbox(group.imageBbox) : null;
  if (fromGroup) return fromGroup;

  const nums = group.questions.map((q) => q.questionNumber);
  if (!nums.length) return undefined;
  const startQ = Math.min(...nums);
  const endQ = Math.max(...nums);

  if (parsedPart.partNumber === 6 || parsedPart.partNumber === 7) {
    const page =
      (group.sourcePage ? pageLayoutCache.get(group.sourcePage) : undefined) ??
      findPageForPassageHeader(
        { pages: [...pageLayoutCache.values()] },
        startQ,
        endQ
      );
    if (!page) return undefined;
    return findPassageBboxOnPage(page, startQ, endQ) ?? undefined;
  }

  return undefined;
}

async function prepareAssetsPyMuPdf(
  testId: string,
  examType: string,
  examPdfBuffer: Buffer,
  examLayout: PyMuPdfDocumentLayout,
  parts: ParsedPart[]
): Promise<
  Map<
    string,
    {
      imageUrl?: string;
      textRegions?: TextRegion[];
      images?: { imageUrl: string; textRegions?: TextRegion[]; sourcePage?: number }[];
      questionImages: Map<number, string>;
    }
  >
> {
  const assets = new Map<
    string,
    {
      imageUrl?: string;
      textRegions?: TextRegion[];
      images?: { imageUrl: string; textRegions?: TextRegion[]; sourcePage?: number }[];
      questionImages: Map<number, string>;
    }
  >();
  const pageLayoutCache = new Map<number, PyMuPdfDocumentLayout["pages"][0]>();
  const pageAssetCache = new Map<number, { imageUrl: string; textRegions?: TextRegion[] }>();

  for (const page of examLayout.pages) {
    pageLayoutCache.set(page.pageNumber, page);
  }

  async function getOrCreateFullPageAsset(
    sourcePage: number,
    partNumber: number
  ): Promise<{ imageUrl: string; textRegions?: TextRegion[] } | null> {
    const cached = pageAssetCache.get(sourcePage);
    if (cached) return cached;

    try {
      const rendered = await pymupdfRenderPage(examPdfBuffer, sourcePage);
      const page = pageLayoutCache.get(sourcePage);
      const textRegions = page ? spansToTextRegions(page.spans) : undefined;
      const imageKey = await uploadReadingPageImage(
        examType,
        testId,
        partNumber,
        sourcePage,
        rendered
      );
      const entry = {
        imageUrl: imageKey,
        textRegions: textRegions?.length ? textRegions : undefined,
      };
      pageAssetCache.set(sourcePage, entry);
      return entry;
    } catch (error) {
      console.warn(
        `[PyMuPDF Pipeline] Full page render failed page ${sourcePage}:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  for (const parsedPart of parts) {
    for (let gIdx = 0; gIdx < parsedPart.groups.length; gIdx++) {
      const group = parsedPart.groups[gIdx]!;
      const key = `${parsedPart.partNumber}-${gIdx}`;
      const entry: {
        imageUrl?: string;
        textRegions?: TextRegion[];
        images?: { imageUrl: string; textRegions?: TextRegion[]; sourcePage?: number }[];
        questionImages: Map<number, string>;
      } = { questionImages: new Map<number, string>() };
      assets.set(key, entry);

      // Part 5 are standalone single-sentence questions; show parsed question text per
      // question instead of rendering the whole exam page as an image.
      if (parsedPart.partNumber === 5) continue;

      let sourcePage = group.sourcePage ?? group.sourcePages?.[0];
      if (!sourcePage && parsedPart.partNumber === 1) {
        const q = group.questions[0]?.questionNumber;
        if (q) {
          const page = examLayout.pages.find((p) => new RegExp(`\\b${q}\\.`).test(p.text));
          sourcePage = page?.pageNumber;
        }
      }
      if (!sourcePage) continue;

      const bbox = resolveGroupBbox(parsedPart, group, pageLayoutCache);
      if (!bbox) continue;

      const isReadingFullPage =
        parsedPart.partNumber >= 5 &&
        parsedPart.partNumber <= 7 &&
        isFullPageBbox(bbox);

      if (isReadingFullPage) {
        const sourcePages =
          group.sourcePages && group.sourcePages.length > 0
            ? [...new Set(group.sourcePages)]
            : [sourcePage];
        for (const pageNumber of sourcePages) {
          const pageAsset = await getOrCreateFullPageAsset(pageNumber, parsedPart.partNumber);
          if (!pageAsset) continue;
          const asset = {
            imageUrl: pageAsset.imageUrl,
            textRegions: pageAsset.textRegions,
            sourcePage: pageNumber,
          };
          entry.images = [...(entry.images ?? []), asset];
          entry.imageUrl ??= pageAsset.imageUrl;
          entry.textRegions ??= pageAsset.textRegions;
        }
        continue;
      }

      try {
        const cropped = await pymupdfClipPage(examPdfBuffer, sourcePage, bbox);

        if (parsedPart.partNumber === 1) {
          const q = group.questions[0];
          if (!q) continue;
          const imageKey = await uploadPart1QuestionImage(examType, testId, q.questionNumber, cropped);
          entry.questionImages.set(q.questionNumber, imageKey);
          continue;
        }

        const page = pageLayoutCache.get(sourcePage);
        const pageRegions = page ? spansToTextRegions(page.spans) : [];
        const filtered = filterRegionsInsideBbox(pageRegions, bbox);
        const textRegions = remapRegionsToCrop(filtered, bbox);

        entry.imageUrl = await uploadPassageGroupImage(
          examType,
          testId,
          parsedPart.partNumber,
          gIdx,
          cropped
        );
        if (parsedPart.partNumber === 6 || parsedPart.partNumber === 7) {
          entry.textRegions = textRegions.length ? textRegions : undefined;
          entry.images = [
            {
              imageUrl: entry.imageUrl,
              textRegions: entry.textRegions,
              sourcePage,
            },
          ];
        }
      } catch (error) {
        console.warn(
          `[PyMuPDF Pipeline] Asset failed Part ${parsedPart.partNumber} group ${gIdx}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  return assets;
}

export async function processToeicExamPyMuPdfResumable(
  testId: string,
  files: UploadedFileRef[],
  onProgress?: (p: ProcessingProgress) => void,
  ctx?: ProcessToeicExamContext
): Promise<ProcessingResult> {
  const log = (step: string, detail: string) => {
    console.log(`[PyMuPDF Pipeline] ${step}: ${detail}`);
    onProgress?.({ step, detail });
  };

  const test = await prisma.test.findUnique({
    where: { id: testId },
    select: { examType: true },
  });
  if (!test) throw new Error("Không tìm thấy đề thi.");

  const examPdf = files.find((f) => f.fileType === "EXAM_PDF");
  const keyLcPdf = files.find((f) => f.fileType === "KEY_LC_PDF");
  const keyRcImage = files.find((f) => f.fileType === "KEY_RC_IMAGE");
  const audioMp3 = files.find((f) => f.fileType === "AUDIO_MP3");

  if (!examPdf || !keyLcPdf || !keyRcImage) {
    throw new Error("Thiếu file bắt buộc: cần có file đề thi (PDF), KEY LC (PDF), và KEY RC (PDF).");
  }

  await syncUploadedFilesFromRefs(testId, files);

  const pipelineState =
    ctx?.pipelineState && isV2PipelineState(ctx.pipelineState)
      ? ctx.pipelineState
      : createEmptyPipelineStateV2(testId, {
          jobId: ctx?.jobId,
          source: ctx?.source ?? (ctx?.jobId ? "import_job" : "direct_import"),
        });

  const checkpoint = async (state: PipelineStateV1, stepId: PipelineStepId) => {
    if (ctx?.jobId) {
      await savePipelineState(ctx.jobId, state, `Pipeline: ${stepId}`);
    }
  };

  const stepOpts = { onCheckpoint: checkpoint };

  const extractResult = await runPipelineStep(
    pipelineState,
    "pymupdf_extract",
    async () => {
      log("pymupdf_extract", "PyMuPDF: layout + text exam & KEY LC...");
      const examBuffer = await getObjectBuffer(examPdf.s3Key);
      const keyLcBuffer = await getObjectBuffer(keyLcPdf.s3Key);

      const [examText, examLayout, keyLcText] = await Promise.all([
        pymupdfExtractText(examBuffer, "exam.pdf"),
        pymupdfExtractLayout(examBuffer, "exam.pdf"),
        pymupdfExtractText(keyLcBuffer, "key-lc.pdf"),
      ]);

      await persistExtractedText(testId, "EXAM_PDF", examText);
      await persistExtractedText(testId, "KEY_LC_PDF", keyLcText);

      return {
        examText,
        examLayout,
        keyLcText,
        examTextLength: examText.length,
        transcriptTextLength: keyLcText.length,
      } satisfies PyMuPdfExtractResult & ExtractTextsResult;
    },
    stepOpts
  );

  const examBuffer = await getObjectBuffer(examPdf.s3Key);

  const rcAnswers = await runPipelineStep(
    pipelineState,
    "parse_rc_key",
    async () => {
      log("parse_rc_key", "Rule parse KEY RC...");
      const rcBuffer = await getObjectBuffer(keyRcImage.s3Key);
      let rcText = "";
      try {
        rcText = await pymupdfExtractText(rcBuffer, "key-rc.pdf");
      } catch {
        rcText = await extractDocumentText(
          rcBuffer,
          keyRcImage.mimeType || "application/pdf",
          "key-rc.pdf"
        );
      }
      const answers = await resolveRcAnswers(keyRcImage, rcText, pipelineState);
      log("parse_rc_key", `Đã có ${Object.keys(answers).length} đáp án RC.`);
      return answers;
    },
    stepOpts
  );

  const rawListening = await runPipelineStep(
    pipelineState,
    "toeic_parse_listening",
    async () => {
      log("toeic_parse_listening", "Rule parser: Listening Part 1-4...");
      const listening = parseListeningParts(extractResult.keyLcText, extractResult.examText);
      const part1 = attachPart1Images(
        listening.find((p) => p.partNumber === 1)!,
        extractResult.examLayout
      );
      const withVisuals = listening.map((p) => {
        if (p.partNumber === 1) return part1;
        if (p.partNumber === 3 || p.partNumber === 4) {
          const repaired = repairListeningQuestionsFromLayout(
            p.groups,
            extractResult.examLayout,
            p.partNumber
          );
          return {
            ...p,
            groups: attachListeningGroupVisuals(
              repaired,
              extractResult.examLayout,
              p.partNumber
            ),
          };
        }
        return p;
      });

      for (const partNum of [3, 4] as const) {
        const part = withVisuals.find((p) => p.partNumber === partNum);
        if (!part) continue;
        const withBbox = part.groups.filter((g) => g.sourcePage && g.imageBbox).length;
        log(
          "toeic_parse_listening",
          `Part ${partNum}: ${withBbox}/${part.groups.length} groups with graphic bbox.`
        );
      }

      return withVisuals;
    },
    stepOpts
  );

  const rawReading = await runPipelineStep(
    pipelineState,
    "toeic_parse_reading",
    async () => {
      log("toeic_parse_reading", "Rule parser: Reading Part 5-7...");
      const prior = getStepState(pipelineState, "toeic_parse_reading").result as
        | ReadingParseProgress
        | undefined;

      const progress: ReadingParseProgress = {
        part5: prior?.part5 ?? parseReadingPart5(extractResult.examText, extractResult.examLayout, rcAnswers),
        part6: prior?.part6 ?? parseReadingPart6(extractResult.examText, extractResult.examLayout, rcAnswers),
        part7Groups: prior?.part7Groups ?? [],
        completedChunks: prior?.completedChunks ?? [],
      };

      for (const { start, end } of PART7_CHUNK_RANGES) {
        const key = chunkKey(start, end);
        if (progress.completedChunks.includes(key)) continue;

        const chunk = parseReadingPart7Chunk(
          extractResult.examText,
          extractResult.examLayout,
          rcAnswers,
          start,
          end
        );
        progress.part7Groups.push(...chunk.groups);
        progress.completedChunks.push(key);

        setStepDone(pipelineState, "toeic_parse_reading", progress);
        await checkpoint(pipelineState, "toeic_parse_reading");
        log("toeic_parse_reading", `Part 7 chunk ${start}-${end} done.`);
      }

      const readingParts = [
        progress.part5!,
        progress.part6!,
        { partNumber: 7 as const, groups: progress.part7Groups },
      ];
      for (const line of summarizeReadingParse(readingParts)) {
        log("toeic_parse_reading", line);
        console.warn(line);
      }

      return readingParts satisfies RawToeicPart[];
    },
    stepOpts
  );

  const rawDocument: RawToeicDocument = {
    parts: [...rawListening, ...rawReading],
  };

  const normalizedParts = await runPipelineStep(
    pipelineState,
    "gemini_normalize",
    async () => {
      log("gemini_normalize", "Gemini normalize all parts...");
      const parts: ParsedPart[] = [];
      for (const raw of rawDocument.parts) {
        parts.push(await normalizeRawPart(raw, pipelineState, stepOpts, log));
      }
      return normalizeParsedParts(parts);
    },
    stepOpts
  );

  await runPipelineStep(
    pipelineState,
    "save_assets",
    async () => {
      log("save_assets", "PyMuPDF clip + S3 upload...");
      const assets = await prepareAssetsPyMuPdf(
        testId,
        test.examType,
        examBuffer,
        extractResult.examLayout,
        normalizedParts
      );
      return serializePreparedAssets(assets);
    },
    stepOpts
  );

  const result = await runPipelineStep(
    pipelineState,
    "save_db",
    async () => {
      log("save_db", "Lưu câu hỏi vào DB...");
      return importParsedToeicData(
        testId,
        { parts: normalizedParts, audioS3Key: audioMp3?.s3Key ?? null },
        {
          overwriteExisting: true,
          examPdfBuffer: examBuffer,
          examType: test.examType,
          preparedAssetsOverride: deserializePreparedAssets(
            getStepState(pipelineState, "save_assets").result as
              | Record<string, PreparedGroupAssetsSerializable>
              | undefined
          ),
          onImportLog: (detail) => log("save_db", detail),
        }
      );
    },
    stepOpts
  );

  log("done", `Hoàn tất PyMuPDF pipeline: ${result.totalQuestions} câu.`);
  return result;
}
