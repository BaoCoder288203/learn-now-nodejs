import type {
  PipelineStateV1,
  PipelineStepId,
  PipelineStepState,
} from "./importPipelineState.js";
import {
  getStepState,
  setStepDone,
  setStepFailed,
  setStepRunning,
} from "./importPipelineState.js";
import { getErrorMessage } from "./ai/jsonUtils.js";
import { AiPartialOutputError } from "./ai/jsonUtils.js";

export interface RunStepOptions {
  onCheckpoint?: (state: PipelineStateV1, stepId: PipelineStepId) => Promise<void>;
}

export async function runPipelineStep<T>(
  state: PipelineStateV1,
  stepId: PipelineStepId,
  fn: () => Promise<T>,
  options?: RunStepOptions
): Promise<T> {
  const existing = getStepState(state, stepId);

  if (existing.status === "done" && existing.result !== undefined) {
    state.skippedStepCount = (state.skippedStepCount ?? 0) + 1;
    console.log(`[Pipeline] step=${stepId} status=skip`);
    return existing.result as T;
  }

  setStepRunning(state, stepId);
  console.log(`[Pipeline] step=${stepId} status=run`);

  try {
    const result = await fn();
    setStepDone(state, stepId, result);
    await options?.onCheckpoint?.(state, stepId);
    console.log(`[Pipeline] step=${stepId} status=done`);
    return result;
  } catch (error) {
    const partial =
      error instanceof AiPartialOutputError
        ? error.partialText
        : undefined;
    setStepFailed(state, stepId, getErrorMessage(error), partial);
    await options?.onCheckpoint?.(state, stepId);
    console.log(`[Pipeline] step=${stepId} status=failed`);
    throw error;
  }
}

export function getAiStepForResume(state: PipelineStateV1, stepId: PipelineStepId): PipelineStepState {
  const step = getStepState(state, stepId);
  if (step.status === "failed" && step.partialText) {
    return step;
  }
  return step;
}
