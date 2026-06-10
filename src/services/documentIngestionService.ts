import { IngestionStatus, type IngestionFileRole } from "@prisma/client";
import { prisma } from "../db.js";
import { buildCanonicalPayload, type CanonicalFileRole } from "./canonicalDocService.js";
import { extractDocumentText } from "./documentExtractService.js";
import {
  processToeicExamResumable,
  type UploadedFileRef,
} from "./examProcessingService.js";
import { syncUploadedFilesFromRefs } from "./uploadedFileSyncService.js";
import type { ExamFileType } from "./s3ObjectKey.js";
import {
  findLastFailedStep,
  parsePipelineState,
  setStepDone,
} from "./importPipelineState.js";
import {
  ensurePipelineState,
  loadPipelineStateForJob,
  markJobFailed,
  savePipelineState,
} from "./importPipelinePersistence.js";
import { classifyToeicFileRoles } from "./toeicAiService.js";

export interface UploadedBatchFile {
  originalName: string;
  mimeType: string;
  storageKey: string;
  buffer: Buffer;
}

function isDocumentLike(mimeType: string): boolean {
  return (
    mimeType === "application/pdf" ||
    mimeType.startsWith("image/") ||
    mimeType.includes("word") ||
    mimeType.includes("presentation") ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("officedocument")
  );
}

async function extractTextForFile(file: UploadedBatchFile): Promise<string> {
  if (isDocumentLike(file.mimeType)) {
    return extractDocumentText(file.buffer, file.mimeType, file.originalName);
  }
  return "";
}

function prismaRoleToCanonical(role: IngestionFileRole | null): CanonicalFileRole {
  if (role === "EXAM_DOC") return "EXAM_DOC";
  if (role === "LISTENING_KEY_DOC") return "LISTENING_KEY_DOC";
  if (role === "READING_KEY_IMAGE") return "READING_KEY_IMAGE";
  if (role === "AUDIO_FILE") return "AUDIO_FILE";
  return "UNKNOWN";
}

function roleToExamFileType(role: CanonicalFileRole): ExamFileType | null {
  switch (role) {
    case "EXAM_DOC":
      return "EXAM_PDF";
    case "LISTENING_KEY_DOC":
      return "KEY_LC_PDF";
    case "READING_KEY_IMAGE":
      return "KEY_RC_IMAGE";
    case "AUDIO_FILE":
      return "AUDIO_MP3";
    default:
      return null;
  }
}

function roleToPrismaEnum(role: CanonicalFileRole): IngestionFileRole {
  if (role === "EXAM_DOC") return "EXAM_DOC";
  if (role === "LISTENING_KEY_DOC") return "LISTENING_KEY_DOC";
  if (role === "READING_KEY_IMAGE") return "READING_KEY_IMAGE";
  if (role === "AUDIO_FILE") return "AUDIO_FILE";
  return "UNKNOWN";
}

export async function runDocumentIngestionJob(
  jobId: string,
  testId: string,
  uploadedFiles: UploadedBatchFile[]
): Promise<void> {
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: { status: IngestionStatus.EXTRACTING, progressStep: "Extracting PDF content" },
  });

  const parsedFiles: Array<{
    name: string;
    mimeType: string;
    storageKey: string;
    text: string;
  }> = [];

  for (const file of uploadedFiles) {
    const text = await extractTextForFile(file);
    parsedFiles.push({
      name: file.originalName,
      mimeType: file.mimeType,
      storageKey: file.storageKey,
      text,
    });
  }

  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: { status: IngestionStatus.CLASSIFYING, progressStep: "Classifying file roles" },
  });

  const canonical = buildCanonicalPayload(
    parsedFiles.map((f) => ({
      name: f.name,
      mimeType: f.mimeType,
      storageKey: f.storageKey,
      text: f.text,
    })),
    Number(process.env.AUTO_IMPORT_THRESHOLD || 0.9)
  );

  const pipelineState = await ensurePipelineState(jobId, testId, "import_job");

  const aiPredictions = await classifyToeicFileRoles(
    parsedFiles.map((f) => ({
      fileName: f.name,
      mimeType: f.mimeType,
      textSample: f.text.slice(0, 4000),
    })),
    pipelineState.steps.classify
  ).catch(() => []);

  setStepDone(pipelineState, "classify", aiPredictions);
  await savePipelineState(jobId, pipelineState, "Classify done");

  for (const file of canonical.files) {
    const ai = aiPredictions.find((p) => p.fileName === file.name);
    if (ai && ai.confidence >= file.confidence) {
      file.role = ai.role as CanonicalFileRole;
      file.confidence = Math.max(0, Math.min(1, ai.confidence));
    }
  }
  const normalizedConfidence =
    canonical.files.reduce((sum, f) => sum + f.confidence, 0) /
    Math.max(canonical.files.length, 1);
  canonical.confidence = normalizedConfidence;
  const requiredRoles: CanonicalFileRole[] = [
    "EXAM_DOC",
    "LISTENING_KEY_DOC",
    "READING_KEY_IMAGE",
  ];
  canonical.needsReview =
    normalizedConfidence < Number(process.env.AUTO_IMPORT_THRESHOLD || 0.9) ||
    requiredRoles.some((role) => !canonical.files.some((f) => f.role === role)) ||
    canonical.files.some((f) => f.role === "UNKNOWN");

  for (const f of canonical.files) {
    await prisma.ingestionFile.updateMany({
      where: { ingestionJobId: jobId, storageKey: f.storageKey },
      data: {
        detectedRole: roleToPrismaEnum(f.role),
        confidence: f.confidence,
        extractionSummary: f.text.slice(0, 2000),
      },
    });
  }

  await prisma.ingestionDraft.upsert({
    where: { ingestionJobId: jobId },
    create: {
      ingestionJobId: jobId,
      canonicalJson: canonical as unknown as object,
      classificationJson: canonical.suggestions as unknown as object,
      reviewPayload: {
        needsReview: canonical.needsReview,
        suggestions: canonical.suggestions,
      } as unknown as object,
    },
    update: {
      canonicalJson: canonical as unknown as object,
      classificationJson: canonical.suggestions as unknown as object,
      reviewPayload: {
        needsReview: canonical.needsReview,
        suggestions: canonical.suggestions,
      } as unknown as object,
    },
  });

  if (canonical.needsReview) {
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: {
        status: IngestionStatus.REVIEW_REQUIRED,
        reviewRequired: true,
        confidence: canonical.confidence,
        progressStep: "Waiting admin review",
      },
    });
    return;
  }

  await importAfterReview(jobId, testId);
}

export async function importAfterReview(jobId: string, testId: string): Promise<void> {
  const ingestion = await prisma.ingestionJob.findUnique({
    where: { id: jobId },
    include: { files: true, draft: true },
  });

  if (!ingestion) {
    throw new Error("Không tìm thấy ingestion job.");
  }

  const refs: UploadedFileRef[] = ingestion.files
    .map((f) => {
      const examType = roleToExamFileType(prismaRoleToCanonical(f.detectedRole));
      if (!examType) return null;
      return {
        fileType: examType,
        s3Key: f.storageKey,
        mimeType: f.mimeType,
      };
    })
    .filter((v): v is UploadedFileRef => !!v);

  const required: ExamFileType[] = ["EXAM_PDF", "KEY_LC_PDF", "KEY_RC_IMAGE"];
  for (const reqType of required) {
    if (!refs.some((r) => r.fileType === reqType)) {
      await prisma.ingestionJob.update({
        where: { id: jobId },
        data: {
          status: IngestionStatus.REVIEW_REQUIRED,
          reviewRequired: true,
          errorMessage: `Thiếu file bắt buộc sau phân loại: ${reqType}.`,
        },
      });
      return;
    }
  }

  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: IngestionStatus.IMPORTING,
      progressStep: "Importing TOEIC structure",
      errorMessage: null,
      lastFailedStep: null,
    },
  });

  const existingState = parsePipelineState(ingestion.draft?.pipelineState);
  const pipelineState =
    existingState && existingState.testId === testId
      ? existingState
      : await ensurePipelineState(jobId, testId, "import_job");

  const fileNames: Partial<Record<ExamFileType, string>> = {};
  for (const f of ingestion.files) {
    const examType = roleToExamFileType(prismaRoleToCanonical(f.detectedRole));
    if (examType) {
      fileNames[examType] = f.originalName;
    }
  }
  await syncUploadedFilesFromRefs(testId, refs, fileNames);

  const progressLog: Array<{ step: string; detail: string }> = [];

  try {
    const result = await processToeicExamResumable(testId, refs, (p) => progressLog.push(p), {
      jobId,
      pipelineState,
      source: "import_job",
    });

    await prisma.ingestionDraft.upsert({
      where: { ingestionJobId: jobId },
      create: {
        ingestionJobId: jobId,
        canonicalJson: ingestion.draft?.canonicalJson ?? {},
        pipelineState: pipelineState as object,
        parsedToeicJson: { progressLog, result } as unknown as object,
      },
      update: {
        pipelineState: pipelineState as object,
        parsedToeicJson: { progressLog, result } as unknown as object,
      },
    });

    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: {
        status: IngestionStatus.DONE,
        reviewRequired: false,
        progressStep: "Done",
        lastFailedStep: null,
        errorMessage: null,
        resultSummary: JSON.stringify(result),
      },
    });
  } catch (error) {
    const failedStep = findLastFailedStep(pipelineState) ?? "save_db";
    await markJobFailed(jobId, failedStep, error, pipelineState);
    throw error;
  }
}

export async function resumeImportJob(jobId: string): Promise<void> {
  const job = await prisma.ingestionJob.findUnique({
    where: { id: jobId },
    select: { id: true, testId: true, status: true },
  });

  if (!job) {
    throw new Error("Không tìm thấy import job.");
  }

  if (job.status !== IngestionStatus.FAILED && job.status !== IngestionStatus.IMPORTING) {
    throw new Error(
      `Chỉ resume job ở trạng thái FAILED hoặc IMPORTING (hiện tại: ${job.status}).`
    );
  }

  await importAfterReview(jobId, job.testId);
}
