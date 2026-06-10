import type { ParsedPart, RcAnswerMap } from "./toeicAiService.js";
import { normalizeParsedPart } from "./normalizeParsedToeic.js";

export const PIPELINE_STATE_VERSION = 1;

export type PipelineStepId =
  | "classify"
  | "extract_texts"
  | "parse_rc_answers"
  | "parse_listening_1"
  | "parse_listening_2"
  | "parse_listening_3"
  | "parse_listening_4"
  | "parse_reading_5"
  | "parse_reading_6"
  | "parse_reading_7"
  | "pymupdf_extract"
  | "parse_rc_key"
  | "toeic_parse_listening"
  | "toeic_parse_reading"
  | "gemini_normalize"
  | "gemini_normalize_1"
  | "gemini_normalize_2"
  | "gemini_normalize_3"
  | "gemini_normalize_4"
  | "gemini_normalize_5"
  | "gemini_normalize_6"
  | "gemini_normalize_7"
  | "gemini_normalize_7_chunk_0"
  | "gemini_normalize_7_chunk_1"
  | "gemini_normalize_7_chunk_2"
  | "gemini_normalize_7_chunk_3"
  | "gemini_normalize_7_chunk_4"
  | "gemini_normalize_7_chunk_5"
  | "gemini_normalize_7_chunk_6"
  | "gemini_normalize_7_chunk_7"
  | "save_assets"
  | "save_db";

export type PipelineStepStatus = "pending" | "running" | "done" | "failed";

export interface PipelineStepState {
  status: PipelineStepStatus;
  provider?: string;
  model?: string;
  result?: unknown;
  partialText?: string;
  error?: string;
  updatedAt: string;
}

export interface ExtractTextsResult {
  examTextLength: number;
  transcriptTextLength: number;
}

export interface PipelineStateV1 {
  version: typeof PIPELINE_STATE_VERSION;
  source?: "import_job" | "direct_import";
  testId: string;
  jobId?: string;
  steps: Partial<Record<PipelineStepId, PipelineStepState>>;
  skippedStepCount?: number;
}

export const TOEIC_IMPORT_STEP_ORDER: PipelineStepId[] = [
  "extract_texts",
  "parse_rc_answers",
  "parse_listening_1",
  "parse_listening_2",
  "parse_listening_3",
  "parse_listening_4",
  "parse_reading_5",
  "parse_reading_6",
  "parse_reading_7",
  "save_db",
];

export const TOEIC_IMPORT_STEP_ORDER_V2: PipelineStepId[] = [
  "pymupdf_extract",
  "parse_rc_key",
  "toeic_parse_listening",
  "toeic_parse_reading",
  "gemini_normalize",
  "gemini_normalize_1",
  "gemini_normalize_2",
  "gemini_normalize_3",
  "gemini_normalize_4",
  "gemini_normalize_5",
  "gemini_normalize_6",
  "gemini_normalize_7_chunk_0",
  "gemini_normalize_7_chunk_1",
  "gemini_normalize_7_chunk_2",
  "gemini_normalize_7_chunk_3",
  "gemini_normalize_7_chunk_4",
  "gemini_normalize_7_chunk_5",
  "gemini_normalize_7_chunk_6",
  "gemini_normalize_7_chunk_7",
  "save_assets",
  "save_db",
];

export function isV2PipelineState(state: PipelineStateV1): boolean {
  return (
    !!state.steps.pymupdf_extract ||
    !!state.steps.toeic_parse_listening ||
    !!state.steps.gemini_normalize
  );
}

export function getActiveStepOrder(state?: PipelineStateV1): PipelineStepId[] {
  if (state && isV2PipelineState(state)) {
    return TOEIC_IMPORT_STEP_ORDER_V2;
  }
  return TOEIC_IMPORT_STEP_ORDER;
}

export function createEmptyPipelineState(testId: string, opts?: {
  jobId?: string;
  source?: PipelineStateV1["source"];
}): PipelineStateV1 {
  const steps: Partial<Record<PipelineStepId, PipelineStepState>> = {};
  for (const id of TOEIC_IMPORT_STEP_ORDER) {
    steps[id] = { status: "pending", updatedAt: new Date().toISOString() };
  }
  return {
    version: PIPELINE_STATE_VERSION,
    testId,
    jobId: opts?.jobId,
    source: opts?.source,
    steps,
    skippedStepCount: 0,
  };
}

export function createEmptyPipelineStateV2(testId: string, opts?: {
  jobId?: string;
  source?: PipelineStateV1["source"];
}): PipelineStateV1 {
  const steps: Partial<Record<PipelineStepId, PipelineStepState>> = {};
  for (const id of TOEIC_IMPORT_STEP_ORDER_V2) {
    steps[id] = { status: "pending", updatedAt: new Date().toISOString() };
  }
  return {
    version: PIPELINE_STATE_VERSION,
    testId,
    jobId: opts?.jobId,
    source: opts?.source,
    steps,
    skippedStepCount: 0,
  };
}

export function parsePipelineState(raw: unknown): PipelineStateV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as PipelineStateV1;
  if (obj.version !== PIPELINE_STATE_VERSION || !obj.testId || !obj.steps) return null;
  return obj;
}

export function getStepState(
  state: PipelineStateV1,
  stepId: PipelineStepId
): PipelineStepState {
  return (
    state.steps[stepId] ?? {
      status: "pending",
      updatedAt: new Date().toISOString(),
    }
  );
}

export function setStepRunning(state: PipelineStateV1, stepId: PipelineStepId): void {
  state.steps[stepId] = {
    ...getStepState(state, stepId),
    status: "running",
    error: undefined,
    updatedAt: new Date().toISOString(),
  };
}

export function setStepDone(
  state: PipelineStateV1,
  stepId: PipelineStepId,
  result: unknown,
  meta?: { provider?: string; model?: string }
): void {
  state.steps[stepId] = {
    status: "done",
    result,
    provider: meta?.provider,
    model: meta?.model,
    updatedAt: new Date().toISOString(),
  };
}

export function setStepFailed(
  state: PipelineStateV1,
  stepId: PipelineStepId,
  error: string,
  partialText?: string
): void {
  state.steps[stepId] = {
    ...getStepState(state, stepId),
    status: "failed",
    error,
    partialText,
    updatedAt: new Date().toISOString(),
  };
}

/** Persist partial AI output while a step is still running (crash-safe resume). */
export function setStepPartialProgress(
  state: PipelineStateV1,
  stepId: PipelineStepId,
  partialText: string
): void {
  state.steps[stepId] = {
    ...getStepState(state, stepId),
    status: "running",
    partialText,
    error: undefined,
    updatedAt: new Date().toISOString(),
  };
}

const EXPECTED_QUESTIONS_PER_PART: Record<number, number> = {
  1: 6,
  2: 25,
  3: 39,
  4: 30,
  5: 30,
  6: 16,
  7: 54,
};

const PARSE_STEP_BY_PART: Record<number, PipelineStepId> = {
  1: "parse_listening_1",
  2: "parse_listening_2",
  3: "parse_listening_3",
  4: "parse_listening_4",
  5: "parse_reading_5",
  6: "parse_reading_6",
  7: "parse_reading_7",
};

function countQuestionsInPart(part: ParsedPart): number {
  return part.groups.reduce((sum, g) => sum + g.questions.length, 0);
}

/**
 * If a done parse step has the wrong question count after normalize, reset it (and save_db) so resume re-parses.
 */
export function resetIncompleteParseSteps(state: PipelineStateV1): PipelineStepId[] {
  const reset: PipelineStepId[] = [];

  for (const [partKey, expected] of Object.entries(EXPECTED_QUESTIONS_PER_PART)) {
    const partNumber = Number(partKey);
    const stepId = PARSE_STEP_BY_PART[partNumber];
    if (!stepId) continue;

    const step = getStepState(state, stepId);
    if (step.status !== "done" || step.result == null) continue;

    const normalized = normalizeParsedPart(step.result, partNumber);
    const actual = countQuestionsInPart(normalized);
    if (actual !== expected) {
      console.warn(
        `[Pipeline] ${stepId}: expected ${expected} questions, got ${actual} — reset for re-parse`
      );
      state.steps[stepId] = {
        status: "pending",
        updatedAt: new Date().toISOString(),
      };
      reset.push(stepId);
    }
  }

  const saveStep = getStepState(state, "save_db");
  if (saveStep.status === "failed" || reset.length > 0) {
    state.steps.save_db = {
      status: "pending",
      updatedAt: new Date().toISOString(),
    };
    if (!reset.includes("save_db")) {
      reset.push("save_db");
    }
  }

  // Bad Part 7 parse (e.g. qwen-max JSON lỗi) — force re-parse even if count check missed edge cases
  const p7 = getStepState(state, "parse_reading_7");
  if (p7.status === "done" && p7.result != null) {
    const normalized = normalizeParsedPart(p7.result, 7);
    const qCount = countQuestionsInPart(normalized);
    const raw = p7.result as { groups?: unknown[] };
    const rawBroken =
      Array.isArray(raw.groups) &&
      raw.groups.some((g) => {
        const gr = g as { questions?: unknown };
        return gr.questions != null && !Array.isArray(gr.questions);
      });
    if (qCount !== EXPECTED_QUESTIONS_PER_PART[7]! || rawBroken) {
      console.warn(
        `[Pipeline] parse_reading_7: invalid shape or ${qCount}/54 questions — reset for re-parse`
      );
      state.steps.parse_reading_7 = {
        status: "pending",
        updatedAt: new Date().toISOString(),
      };
      if (!reset.includes("parse_reading_7")) {
        reset.push("parse_reading_7");
      }
      state.steps.save_db = {
        status: "pending",
        updatedAt: new Date().toISOString(),
      };
    }
  }

  return reset;
}

export function collectParsedParts(state: PipelineStateV1): ParsedPart[] {
  const parts: ParsedPart[] = [];
  for (const n of [1, 2, 3, 4] as const) {
    const step = getStepState(state, `parse_listening_${n}`);
    if (step.status === "done" && step.result) {
      parts.push(normalizeParsedPart(step.result, n));
    }
  }
  for (const n of [5, 6, 7] as const) {
    const step = getStepState(state, `parse_reading_${n}`);
    if (step.status === "done" && step.result) {
      parts.push(normalizeParsedPart(step.result, n));
    }
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

export function getRcAnswersFromState(state: PipelineStateV1): RcAnswerMap | null {
  const step = getStepState(state, "parse_rc_answers");
  if (step.status !== "done" || !step.result) return null;
  return step.result as RcAnswerMap;
}

export function findLastFailedStep(state: PipelineStateV1): PipelineStepId | null {
  const order = getActiveStepOrder(state);
  for (const stepId of [...order].reverse()) {
    if (getStepState(state, stepId).status === "failed") {
      return stepId;
    }
  }
  if (state.steps.classify?.status === "failed") {
    return "classify";
  }
  return null;
}

export function pipelineStepsSummary(state: PipelineStateV1): Array<{
  stepId: PipelineStepId;
  status: PipelineStepStatus;
  error?: string;
}> {
  return getActiveStepOrder(state).map((stepId) => {
    const s = getStepState(state, stepId);
    return { stepId, status: s.status, error: s.error };
  });
}
