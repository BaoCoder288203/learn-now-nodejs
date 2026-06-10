import { prisma } from "../db.js";
import {
  createEmptyPipelineState,
  parsePipelineState,
  type PipelineStateV1,
} from "./importPipelineState.js";

export async function loadPipelineStateForJob(jobId: string): Promise<PipelineStateV1 | null> {
  const draft = await prisma.ingestionDraft.findUnique({
    where: { ingestionJobId: jobId },
    select: { pipelineState: true },
  });
  return parsePipelineState(draft?.pipelineState);
}

export async function savePipelineState(
  jobId: string,
  state: PipelineStateV1,
  progressStep?: string
): Promise<void> {
  await prisma.ingestionDraft.upsert({
    where: { ingestionJobId: jobId },
    create: {
      ingestionJobId: jobId,
      canonicalJson: {},
      pipelineState: state as object,
    },
    update: {
      pipelineState: state as object,
    },
  });

  if (progressStep) {
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: { progressStep },
    });
  }
}

export async function ensurePipelineState(
  jobId: string,
  testId: string,
  source: PipelineStateV1["source"] = "import_job"
): Promise<PipelineStateV1> {
  const existing = await loadPipelineStateForJob(jobId);
  if (existing && existing.testId === testId) {
    return existing;
  }
  const state = createEmptyPipelineState(testId, { jobId, source });
  await savePipelineState(jobId, state, "Pipeline initialized");
  return state;
}

export async function markJobFailed(
  jobId: string,
  stepId: string,
  error: unknown,
  state: PipelineStateV1
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await savePipelineState(jobId, state);
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: "FAILED",
      lastFailedStep: stepId,
      errorMessage: message,
      progressStep: `Failed at ${stepId}`,
    },
  });
}
