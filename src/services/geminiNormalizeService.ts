import { alibabaChatJson } from "./ai/alibabaProvider.js";
import { deepseekChatJson } from "./ai/deepseekProvider.js";
import { compatibleChatHandlers } from "./ai/compatibleChatHandlers.js";
import {
  generateJsonWithDualProviders,
  type GenerateJsonOptions,
  type ProviderHandlers,
  type ProviderRunFn,
} from "./ai/dualProvider.js";
import { buildGeminiSinglePartSchema, getGeminiClient } from "./ai/geminiProvider.js";
import {
  AiPartialOutputError,
  isJsonParseFailure,
  safeParseJson,
} from "./ai/jsonUtils.js";
import { openaiChatJson } from "./ai/openaiProvider.js";
import { buildContinuationPrompt } from "./ai/resumeContext.js";
import { SINGLE_PART_JSON_SCHEMA } from "./ai/schemas.js";
import type { AiProviderName } from "./ai/types.js";
import type { PipelineStepState } from "./importPipelineState.js";
import type { ParsedPart, ParsedQuestion } from "./ai/types.js";
import type { RawToeicPart, RawToeicQuestion } from "./toeicRuleParser/types.js";
import { PART_RANGES } from "./toeicRuleParser/patterns.js";
import { normalizeParsedPart } from "./normalizeParsedToeic.js";

const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 16384;
const MAX_CONTINUATION_ROUNDS =
  Number(process.env.GEMINI_NORMALIZE_MAX_CONTINUATIONS) || 10;
/** Alibaba/Qwen input limit ~30720; keep continuation prompts under this. */
const MAX_PROMPT_CHARS = Number(process.env.NORMALIZE_MAX_PROMPT_CHARS) || 28_000;

const PART_SCHEMA = {
  name: "ParsedPart",
  schema: SINGLE_PART_JSON_SCHEMA as unknown as Record<string, unknown>,
};

export interface GeminiNormalizeOptions {
  /** Checkpoint partial JSON between continuation rounds (crash-safe resume). */
  onPartial?: (partialText: string) => void | Promise<void>;
  /** When normalizing a Part 7 sub-chunk, limit scope to these question numbers. */
  questionRange?: { start: number; end: number };
}

function capPartialText(partial: string): string {
  const overhead = 800;
  const maxPartial = Math.max(1000, MAX_PROMPT_CHARS - overhead);
  if (partial.length <= maxPartial) return partial;
  return `${partial.slice(0, maxPartial)}\n...[truncated for provider input limit]`;
}

function buildContinuationPromptCapped(label: string, partialText: string): string {
  return buildContinuationPrompt(label, capPartialText(partialText));
}

function rawPartToPrompt(raw: RawToeicPart): string {
  return JSON.stringify(raw, null, 0);
}

function buildBasePrompt(raw: RawToeicPart, questionRange?: { start: number; end: number }): string {
  const rangeRule = questionRange
    ? `- This chunk covers questions ${questionRange.start}-${questionRange.end} only.\n`
    : "";

  return `You are a TOEIC exam data normalizer. Fix and complete the raw parsed JSON below into strict valid JSON for Part ${raw.partNumber} only.

Rules:
${rangeRule}- Output a single JSON object with partNumber and groups array.
- Each question must have questionNumber, questionText, options (array of {letter, text}), correctAnswer.
- Preserve passage, transcript, sourcePage, imageBbox when present.
- Fix missing options, wrong shapes, and incomplete fields.
- Do not invent questions outside this part's expected range.

--- RAW PARSED JSON ---
${rawPartToPrompt(raw)}`;
}

function geminiRunForPrompt(label: string, prompt: string): ProviderRunFn {
  return (model) =>
    getGeminiClient()
      .models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: buildGeminiSinglePartSchema(),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      })
      .then((response) => {
        const text = response.text ?? "";
        if (!text.trim()) {
          throw new Error(`${label}: Gemini returned empty response`);
        }
        if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
          throw new AiPartialOutputError(text, `${label}: output truncated`, "length");
        }
        return { text };
      });
}

function providerRunForPrompt(
  label: string,
  prompt: string,
  provider: AiProviderName
): ProviderRunFn {
  if (provider === "gemini") {
    return geminiRunForPrompt(label, prompt);
  }
  const messages = [{ role: "user" as const, content: prompt }];
  if (provider === "alibaba") {
    return (model) => alibabaChatJson(model, messages, PART_SCHEMA, label);
  }
  if (provider === "openai") {
    return (model) => openaiChatJson(model, messages, PART_SCHEMA, label);
  }
  if (provider === "deepseek") {
    return (model) => deepseekChatJson(model, messages, PART_SCHEMA, label);
  }
  return geminiRunForPrompt(label, prompt);
}

function buildHandlers(label: string, prompt: string): ProviderHandlers {
  const messages = [{ role: "user" as const, content: prompt }];
  return {
    ...compatibleChatHandlers(messages, PART_SCHEMA, label),
    gemini: geminiRunForPrompt(label, prompt),
  };
}

function buildDualOptions(label: string, carryPartial?: string): GenerateJsonOptions {
  return {
    resume: carryPartial
      ? { mode: "continue_json", partialText: carryPartial }
      : undefined,
    buildContinuationRun: (partialText, provider) =>
      providerRunForPrompt(
        label,
        buildContinuationPromptCapped(label, partialText),
        provider
      ),
  };
}

function extractPartialFromError(error: unknown): string | undefined {
  if (error instanceof AiPartialOutputError) {
    return error.partialText;
  }
  return undefined;
}

function clipPartToQuestionRange(
  part: ParsedPart,
  questionRange?: { start: number; end: number }
): ParsedPart {
  const range = questionRange ?? PART_RANGES[part.partNumber];
  if (!range) return part;

  const groups = part.groups
    .map((group) => ({
      ...group,
      questions: group.questions.filter(
        (question) =>
          question.questionNumber >= range.start && question.questionNumber <= range.end
      ),
    }))
    .filter((group) => group.questions.length > 0);

  return { ...part, groups };
}

const OPTION_LETTERS = ["A", "B", "C", "D"] as const;

function rawQuestionToParsed(question: RawToeicQuestion): ParsedQuestion {
  const options = [...question.options];
  while (options.length < 4) options.push("-");

  return {
    questionNumber: question.questionNumber,
    questionText: question.questionText,
    options: options.slice(0, 4).map((text, index) => ({
      letter: OPTION_LETTERS[index]!,
      text: text || "-",
    })),
    correctAnswer: question.correctAnswer ?? "",
  };
}

/** Rule-parsed reading parts: keep exact passage/group structure from raw (no AI reshape). */
export function convertRawPartToParsed(
  raw: RawToeicPart,
  questionRange?: { start: number; end: number }
): ParsedPart {
  const range = questionRange ?? PART_RANGES[raw.partNumber];
  const groups = raw.groups
    .map((group) => ({
      passage: group.passage,
      transcript: group.transcript,
      sourcePage: group.sourcePage,
      sourcePages: group.sourcePages,
      imageBbox: group.imageBbox,
      questions: group.questions
        .filter(
          (question) =>
            !range ||
            (question.questionNumber >= range.start && question.questionNumber <= range.end)
        )
        .map((question) => rawQuestionToParsed(question)),
    }))
    .filter((group) => group.questions.length > 0);

  return normalizeParsedPart({ partNumber: raw.partNumber, groups }, raw.partNumber);
}

function restoreMetadataFromRaw(part: ParsedPart, raw: RawToeicPart): ParsedPart {
  const rawByKey = new Map(
    raw.groups.map((group) => [
      group.questions
        .map((q) => q.questionNumber)
        .sort((a, b) => a - b)
        .join(","),
      group,
    ])
  );

  const groups = part.groups.map((group) => {
    const key = group.questions
      .map((q) => q.questionNumber)
      .sort((a, b) => a - b)
      .join(",");
    const rawGroup = rawByKey.get(key);
    if (!rawGroup) return group;
    return {
      ...group,
      passage: group.passage?.trim() ? group.passage : rawGroup.passage,
      transcript: group.transcript?.trim() ? group.transcript : rawGroup.transcript,
      sourcePage: group.sourcePage ?? rawGroup.sourcePage,
      imageBbox: group.imageBbox ?? rawGroup.imageBbox,
    };
  });

  return { ...part, groups };
}

function backfillMissingFromRaw(
  part: ParsedPart,
  raw: RawToeicPart,
  questionRange?: { start: number; end: number }
): ParsedPart {
  const range = questionRange ?? PART_RANGES[part.partNumber];
  if (!range) return part;

  const present = new Set(
    part.groups.flatMap((group) => group.questions.map((question) => question.questionNumber))
  );

  const missing = raw.groups
    .flatMap((group) => group.questions)
    .filter(
      (question) =>
        question.questionNumber >= range.start &&
        question.questionNumber <= range.end &&
        !present.has(question.questionNumber)
    );

  if (!missing.length) return part;

  const groups = [...part.groups];
  for (const question of missing) {
    groups.push({ questions: [rawQuestionToParsed(question)] });
  }

  return { ...part, groups };
}

async function normalizePartWithProviders(
  label: string,
  prompt: string,
  partNumber: number,
  carryPartial?: string
): Promise<ParsedPart> {
  return generateJsonWithDualProviders(
    label,
    buildHandlers(label, prompt),
    (text) => normalizeParsedPart(safeParseJson<ParsedPart>(text, label), partNumber),
    buildDualOptions(label, carryPartial)
  );
}

export async function geminiNormalizePart(
  raw: RawToeicPart,
  aiStep?: PipelineStepState,
  options?: GeminiNormalizeOptions
): Promise<ParsedPart> {
  return geminiNormalizePartInternal(raw, aiStep, options?.questionRange, options);
}

async function geminiNormalizePartInternal(
  raw: RawToeicPart,
  aiStep?: PipelineStepState,
  questionRange?: { start: number; end: number },
  options?: GeminiNormalizeOptions
): Promise<ParsedPart> {
  const label = questionRange
    ? `geminiNormalizePart${raw.partNumber}_${questionRange.start}_${questionRange.end}`
    : `geminiNormalizePart${raw.partNumber}`;
  const basePrompt = buildBasePrompt(raw, questionRange);

  let carryPartial = aiStep?.partialText;
  let lastText = "";

  for (let round = 0; round < MAX_CONTINUATION_ROUNDS; round++) {
    const prompt = carryPartial
      ? buildContinuationPromptCapped(label, carryPartial)
      : basePrompt;

    try {
      const normalized = await normalizePartWithProviders(
        label,
        prompt,
        raw.partNumber,
        carryPartial
      );
      const clipped = clipPartToQuestionRange(normalized, questionRange);
      const backfilled = backfillMissingFromRaw(clipped, raw, questionRange);
      return restoreMetadataFromRaw(backfilled, raw);
    } catch (error) {
      const partial = extractPartialFromError(error);

      if (partial) {
        lastText = partial;
        carryPartial = partial;
        await options?.onPartial?.(partial);
        console.log(
          `[Normalize] ${label}: partial output — continuation round ${round + 1}/${MAX_CONTINUATION_ROUNDS} (${partial.length} chars), next provider/round will complete JSON`
        );
        continue;
      }

      if (isJsonParseFailure(error) && lastText) {
        carryPartial = lastText;
        await options?.onPartial?.(lastText);
        console.warn(
          `[Normalize] ${label}: JSON parse failed — continuation round ${round + 1}/${MAX_CONTINUATION_ROUNDS}`
        );
        continue;
      }

      throw error;
    }
  }

  throw new AiPartialOutputError(
    lastText || carryPartial || "",
    `${label}: incomplete after ${MAX_CONTINUATION_ROUNDS} continuation rounds`,
    "length"
  );
}

export async function geminiNormalizeDocument(
  rawParts: RawToeicPart[],
  getStepForPart?: (partNumber: number) => PipelineStepState | undefined,
  options?: GeminiNormalizeOptions
): Promise<ParsedPart[]> {
  const out: ParsedPart[] = [];
  for (const raw of rawParts) {
    const step = getStepForPart?.(raw.partNumber);
    out.push(await geminiNormalizePart(raw, step, options));
  }
  return out.sort((a, b) => a.partNumber - b.partNumber);
}
