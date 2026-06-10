import { Type } from "@google/genai";
import { generateJsonWithDualProviders } from "./ai/dualProvider.js";
import {
  buildGeminiSinglePartSchema,
  getGeminiClient,
} from "./ai/geminiProvider.js";
import { safeParseJson } from "./ai/jsonUtils.js";
import {
  alibabaChatJson,
  alibabaChatJsonWithVision,
  alibabaImageMessage,
} from "./ai/alibabaProvider.js";
import {
  openaiChatJson,
  openaiImageMessage,
} from "./ai/openaiProvider.js";
import {
  FILE_ROLE_JSON_SCHEMA,
  IMAGE_BBOX_JSON_SCHEMA,
  SINGLE_PART_JSON_SCHEMA,
  TEXT_REGIONS_JSON_SCHEMA,
} from "./ai/schemas.js";
import { compatibleChatHandlers } from "./ai/compatibleChatHandlers.js";
import { buildToeicAiOptions } from "./ai/toeicAiCallOptions.js";
import type { PipelineStepState } from "./importPipelineState.js";

export type {
  FileRolePrediction,
  ParsedExamData,
  ParsedGroup,
  ParsedOption,
  ParsedPart,
  ParsedQuestion,
  PdfInlineData,
  RcAnswerMap,
  TextRegion,
} from "./ai/types.js";

import type {
  AiProviderName,
  FileRolePrediction,
  NormalizedBbox,
  ParsedExamData,
  ParsedPart,
  PdfInlineData,
  RcAnswerMap,
  TextRegion,
} from "./ai/types.js";

const MAX_OUTPUT_TOKENS_GEMINI = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 8192;

// ---------------------------------------------------------------------------
// Answer key
// ---------------------------------------------------------------------------

export async function parseAnswerKeyImage(
  imageBase64: string,
  mimeType: string,
  aiStep?: PipelineStepState
): Promise<RcAnswerMap> {
  const prompt = `You are looking at a TOEIC Reading Comprehension answer key image.
This image contains a grid or table of correct answers for questions 101-200.

Your task:
1. Read every answer from the image carefully.
2. Map each question number to its correct answer letter (A, B, C, or D).
3. Output ONLY a JSON object with question numbers as string keys and answer letters as values.

Example output: {"101": "B", "102": "C", "103": "A"}

Rules:
- Include ALL questions from 101 to 200.
- If a question is unreadable, use your best guess.
- Output strictly valid JSON with no extra text.`;

  return generateJsonWithDualProviders(
    "parseAnswerKeyImage",
    {
      alibaba: () =>
        alibabaChatJsonWithVision([alibabaImageMessage(imageBase64, mimeType, prompt)]),
      openai: (model) =>
        openaiChatJson(model, [openaiImageMessage(imageBase64, mimeType, prompt)]),
      gemini: (model) =>
        getGeminiClient().models.generateContent({
          model,
          contents: {
            parts: [
              { inlineData: { data: imageBase64, mimeType } },
              { text: prompt },
            ],
          },
          config: {
            responseMimeType: "application/json",
            maxOutputTokens: MAX_OUTPUT_TOKENS_GEMINI,
          },
        }),
    },
    (text) => safeParseJson<RcAnswerMap>(text, "parseAnswerKeyImage"),
    buildToeicAiOptions("parseAnswerKeyImage", aiStep)
  );
}

export async function parseAnswerKeyText(
  answerKeyText: string,
  aiStep?: PipelineStepState
): Promise<RcAnswerMap> {
  const prompt = `You are extracting TOEIC Reading answer keys from plain text (converted from PDF).
This text contains correct answers for questions 101-200.

Your task:
1. Extract answer for each question number from 101 to 200.
2. Output ONLY a JSON object where keys are question numbers (string), values are A/B/C/D.

Example output: {"101":"B","102":"C","103":"A"}

Rules:
- Return valid JSON only, no markdown.
- If one answer is ambiguous, choose best guess.
- Ensure as many keys from 101-200 as possible.`;

  const fullPrompt = `${prompt}\n\n---ANSWER KEY TEXT---\n${answerKeyText}`;

  const messages = [{ role: "user" as const, content: fullPrompt }];

  return generateJsonWithDualProviders(
    "parseAnswerKeyText",
    {
      ...compatibleChatHandlers(messages, undefined, "parseAnswerKeyText"),
      gemini: (model) =>
        getGeminiClient().models.generateContent({
          model,
          contents: fullPrompt,
          config: {
            responseMimeType: "application/json",
            maxOutputTokens: MAX_OUTPUT_TOKENS_GEMINI,
          },
        }),
    },
    (text) => safeParseJson<RcAnswerMap>(text, "parseAnswerKeyText"),
    buildToeicAiOptions("parseAnswerKeyText", aiStep)
  );
}

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------

const LISTENING_PART_INSTRUCTIONS: Record<number, string> = {
  1: `Parse ONLY TOEIC Listening Part 1 (Photographs), questions 1-6.
- Create exactly 6 groups (1 question each).
- questionText: "What is the best description of the photograph?" for all.
- Extract 4 statement options A-D from the transcript for each question.
- Include correctAnswer for each question from the KEY section.
- For each group set sourcePage to the 1-based PDF page number containing that photograph.
- For each group set imageBbox: normalized [x, y, w, h] (0-1) on sourcePage for that photograph ONLY (exclude headers, option text, page chrome).`,
  2: `Parse ONLY TOEIC Listening Part 2 (Question-Response), questions 7-31.
- Create exactly 25 groups (1 question each).
- questionText is the spoken question/statement from the transcript.
- Extract 3 response options A-C; add option D with text "-" if needed.
- Include correctAnswer for each question from the KEY section.`,
  3: `Parse ONLY TOEIC Listening Part 3 (Conversations), questions 32-70.
- Create exactly 13 groups (3 questions per conversation).
- Put the shared conversation in each group's transcript field.
- Each question has 4 options A-D and correctAnswer from the KEY.`,
  4: `Parse ONLY TOEIC Listening Part 4 (Short Talks), questions 71-100.
- Create exactly 10 groups (3 questions per talk).
- Put the shared talk in each group's transcript field.
- Each question has 4 options A-D and correctAnswer from the KEY.`,
};

export async function parseListeningPart(
  transcriptText: string,
  partNumber: 1 | 2 | 3 | 4,
  examPdfInline?: PdfInlineData,
  aiStep?: PipelineStepState
): Promise<ParsedPart> {
  const client = getGeminiClient();
  const partInstructions = LISTENING_PART_INSTRUCTIONS[partNumber];

  const prompt = `You are a TOEIC exam parser. Below is raw text from a "KEY LC + TRANSCRIPT" PDF.
IGNORE all Korean text.

${partInstructions}

Output a single JSON object with partNumber ${partNumber} and a groups array.
Keep transcript/passage strings concise; escape quotes properly in JSON.`;

  const openaiPrompt =
    partNumber === 1 && examPdfInline
      ? `${prompt}\n\nInfer sourcePage from transcript page markers when possible.\n\n---RAW TEXT---\n${transcriptText}`
      : `${prompt}\n\n---RAW TEXT---\n${transcriptText}`;

  const geminiContents =
    partNumber === 1 && examPdfInline
      ? ({
          parts: [
            {
              text:
                `${prompt}\n\n` +
                `Use the attached exam PDF to read Part 1 photograph content/layout directly. ` +
                `Still use transcript text below for options and answer keys.\n\n---RAW TEXT---\n${transcriptText}`,
            },
            { inlineData: examPdfInline },
          ],
        } as Parameters<typeof client.models.generateContent>[0]["contents"])
      : prompt + "\n\n---RAW TEXT---\n" + transcriptText;

  const partSchema = {
    name: "ParsedPart",
    schema: SINGLE_PART_JSON_SCHEMA as unknown as Record<string, unknown>,
  };
  const partMessages = [{ role: "user" as const, content: openaiPrompt }];
  const partLabel = `parseListeningPart${partNumber}`;

  return generateJsonWithDualProviders(
    partLabel,
    {
      ...compatibleChatHandlers(partMessages, partSchema, partLabel),
      gemini: (model) =>
        client.models.generateContent({
          model,
          contents: geminiContents,
          config: {
            responseMimeType: "application/json",
            responseSchema: buildGeminiSinglePartSchema(),
            maxOutputTokens: MAX_OUTPUT_TOKENS_GEMINI,
          },
        }),
    },
    (text) => {
      const parsed = safeParseJson<ParsedPart | ParsedPart[]>(
        text,
        `parseListeningPart${partNumber}`
      );
      if (Array.isArray(parsed)) {
        const match = parsed.find((p) => p.partNumber === partNumber);
        if (match) return match;
        if (parsed.length === 1) return parsed[0]!;
        throw new Error(`parseListeningPart${partNumber}: không tìm thấy part ${partNumber} trong mảng.`);
      }
      return parsed;
    },
    buildToeicAiOptions(`parseListeningPart${partNumber}`, aiStep)
  );
}

export async function parseListeningContent(
  transcriptText: string,
  examPdfInline?: PdfInlineData
): Promise<ParsedPart[]> {
  const parts: ParsedPart[] = [];
  for (const partNumber of [1, 2, 3, 4] as const) {
    console.log(`[AI] Parsing Listening Part ${partNumber}...`);
    const part = await parseListeningPart(transcriptText, partNumber, examPdfInline);
    parts.push({ ...part, partNumber });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const READING_PART_INSTRUCTIONS: Record<number, string> = {
  5: `Parse ONLY TOEIC Reading Part 5 (Incomplete Sentences), questions 101-130.
- Create 30 groups (1 question each).
- questionText is the sentence with a blank.
- 4 options A-D; use the provided answer key for correctAnswer.`,
  6: `Parse ONLY TOEIC Reading Part 6 (Text Completion), questions 131-146.
- Create 4 groups (4 questions each).
- Put the shared passage in the group passage field.
- 4 options A-D per question; use the answer key for correctAnswer.
- For each group set sourcePage to the 1-based PDF page number containing that passage.
- For each group set imageBbox: normalized [x, y, w, h] (0-1) on sourcePage for the passage block ONLY (exclude questions, answer choices, part headers).`,
  7: `Parse ONLY TOEIC Reading Part 7 (Reading Comprehension), questions 147-200.
- Create groups by shared passage (2-5 questions per group).
- Put passage text in the group passage field.
- 4 options A-D per question; use the answer key for correctAnswer.
- For each group set sourcePage to the 1-based PDF page number containing that passage.
- For each group set imageBbox: normalized [x, y, w, h] (0-1) on sourcePage for the passage block ONLY (exclude questions, answer choices, part headers).`,
};

const PART7_PARSE_RANGES = [
  { start: 147, end: 160 },
  { start: 161, end: 173 },
  { start: 174, end: 187 },
  { start: 188, end: 200 },
] as const;

function filterRcAnswersForRange(
  rcAnswers: RcAnswerMap,
  start: number,
  end: number
): RcAnswerMap {
  const out: RcAnswerMap = {};
  for (let i = start; i <= end; i++) {
    const key = String(i);
    if (rcAnswers[key]) out[key] = rcAnswers[key];
  }
  return out;
}

function part7ChunkInstructions(start: number, end: number): string {
  return `Parse ONLY TOEIC Reading Part 7 (Reading Comprehension), questions ${start}-${end} ONLY.
- Do NOT include questions outside ${start}-${end}.
- Create groups by shared passage (2-4 questions per group).
- Put passage text in the group passage field (keep each passage under 2500 characters; do not repeat the full exam).
- Each question: questionNumber, questionText, options as array of exactly 4 strings, correctAnswer (letter A-D).
- For each group set sourcePage to the 1-based PDF page number containing that passage.
- For each group set imageBbox: normalized [x, y, w, h] (0-1) on sourcePage for the passage block ONLY.
- Output compact JSON only (partNumber, groups).`;
}

async function parseReadingPartOnce(
  examText: string,
  rcAnswers: RcAnswerMap,
  partNumber: 5 | 6 | 7,
  partInstructions: string,
  label: string,
  examPdfInline?: PdfInlineData,
  aiStep?: PipelineStepState,
  providerOrder?: AiProviderName[]
): Promise<ParsedPart> {
  const client = getGeminiClient();
  const answersJson = JSON.stringify(rcAnswers);

  const prompt = `You are a TOEIC exam parser. Below is raw text from the READING section of a TOEIC exam PDF.

Correct answer key (question number -> letter):
${answersJson}

${partInstructions}

Output a single JSON object with partNumber ${partNumber} and a groups array.
Escape quotes properly in JSON strings.`;

  const examSnippet =
    partNumber === 7 && examText.length > 80_000
      ? `${examText.slice(0, 40_000)}\n\n[...exam text truncated for token limit...]\n\n${examText.slice(-40_000)}`
      : examText;

  const openaiPrompt =
    partNumber >= 6 && examPdfInline
      ? `${prompt}\n\nUse exam text below to infer passage boundaries and sourcePage.\n\n---EXAM TEXT---\n${examSnippet}`
      : `${prompt}\n\n---EXAM TEXT---\n${examSnippet}`;

  const geminiContents =
    partNumber >= 6 && examPdfInline
      ? ({
          parts: [
            {
              text:
                `${prompt}\n\n` +
                `Use attached exam PDF visual layout to preserve passages/paragraph boundaries for this part.\n\n` +
                `---EXAM TEXT---\n${examSnippet}`,
            },
            { inlineData: examPdfInline },
          ],
        } as Parameters<typeof client.models.generateContent>[0]["contents"])
      : prompt + "\n\n---EXAM TEXT---\n" + examSnippet;

  const partSchema = {
    name: "ParsedPart",
    schema: SINGLE_PART_JSON_SCHEMA as unknown as Record<string, unknown>,
  };
  const partMessages = [{ role: "user" as const, content: openaiPrompt }];

  return generateJsonWithDualProviders(
    label,
    {
      ...compatibleChatHandlers(partMessages, partSchema, label),
      gemini: (model) =>
        client.models.generateContent({
          model,
          contents: geminiContents,
          config: {
            responseMimeType: "application/json",
            responseSchema: buildGeminiSinglePartSchema(),
            maxOutputTokens: MAX_OUTPUT_TOKENS_GEMINI,
          },
        }),
    },
    (text) => {
      const parsed = safeParseJson<ParsedPart | ParsedPart[]>(text, label);
      if (Array.isArray(parsed)) {
        const match = parsed.find((p) => p.partNumber === partNumber);
        if (match) return match;
        if (parsed.length === 1) return parsed[0]!;
        throw new Error(`${label}: không tìm thấy part ${partNumber} trong mảng.`);
      }
      return parsed;
    },
    {
      ...buildToeicAiOptions(label, aiStep),
      ...(providerOrder ? { providerOrder } : {}),
    }
  );
}

export async function parseReadingPart(
  examText: string,
  rcAnswers: RcAnswerMap,
  partNumber: 5 | 6 | 7,
  examPdfInline?: PdfInlineData,
  aiStep?: PipelineStepState
): Promise<ParsedPart> {
  if (partNumber === 7) {
    const allGroups: ParsedPart["groups"] = [];
    for (const { start, end } of PART7_PARSE_RANGES) {
      console.log(`[AI] Parsing Reading Part 7 chunk ${start}-${end}...`);
      const chunk = await parseReadingPartOnce(
        examText,
        filterRcAnswersForRange(rcAnswers, start, end),
        7,
        part7ChunkInstructions(start, end),
        `parseReadingPart7_${start}_${end}`,
        examPdfInline,
        aiStep,
        ["gemini", "openai", "alibaba"]
      );
      allGroups.push(...chunk.groups);
    }
    return { partNumber: 7, groups: allGroups };
  }

  return parseReadingPartOnce(
    examText,
    rcAnswers,
    partNumber,
    READING_PART_INSTRUCTIONS[partNumber],
    `parseReadingPart${partNumber}`,
    examPdfInline,
    aiStep
  );
}

export async function parseReadingContent(
  examText: string,
  rcAnswers: RcAnswerMap,
  examPdfInline?: PdfInlineData
): Promise<ParsedPart[]> {
  const parts: ParsedPart[] = [];
  for (const partNumber of [5, 6, 7] as const) {
    console.log(`[AI] Parsing Reading Part ${partNumber}...`);
    const part = await parseReadingPart(examText, rcAnswers, partNumber, examPdfInline);
    parts.push({ ...part, partNumber });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Legacy parse
// ---------------------------------------------------------------------------

export async function parseToeicContent(
  ocrText: string,
  imageBufferBase64?: { data: string; mimeType: string },
  aiStep?: PipelineStepState
): Promise<ParsedExamData> {
  const client = getGeminiClient();

  const prompt = `You are an exam content parser specialized ONLY in TOEIC exams.
Input: Raw OCR text extracted from image or PDF.
${ocrText ? `Raw OCR Text: "${ocrText}"` : ""}

Your tasks:
1. Detect TOEIC part number (1-7).
2. For each question: extract question text, options (A-D), correct answer.
3. Preserve original wording. Normalize OCR mistakes.
4. Output strictly valid JSON.`;

  const legacySchema = {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      partNumber: { type: "integer" },
      questions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            questionNumber: { type: "integer" },
            passage: { type: "string" },
            questionText: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  letter: { type: "string" },
                  text: { type: "string" },
                },
                required: ["letter", "text"],
              },
            },
            correctAnswer: { type: "string" },
            transcript: { type: "string" },
          },
          required: ["questionNumber", "questionText", "options", "correctAnswer"],
        },
      },
    },
    required: ["partNumber", "questions"],
  };

  const legacySchemaConfig = { name: "ParsedExamData", schema: legacySchema };
  const textMessages = [{ role: "user" as const, content: prompt }];

  return generateJsonWithDualProviders(
    "parseToeicContent",
    {
      ...(imageBufferBase64
        ? {
            alibaba: () =>
              alibabaChatJsonWithVision([
                alibabaImageMessage(imageBufferBase64.data, imageBufferBase64.mimeType, prompt),
              ]),
            openai: (model) =>
              openaiChatJson(
                model,
                [openaiImageMessage(imageBufferBase64.data, imageBufferBase64.mimeType, prompt)],
                legacySchemaConfig,
                "parseToeicContent"
              ),
          }
        : compatibleChatHandlers(textMessages, legacySchemaConfig, "parseToeicContent")),
      gemini: (model) => {
        const contents = imageBufferBase64
          ? {
              parts: [
                {
                  inlineData: {
                    data: imageBufferBase64.data,
                    mimeType: imageBufferBase64.mimeType,
                  },
                },
                { text: prompt },
              ],
            }
          : prompt;

        return client.models.generateContent({
          model,
          contents: contents as Parameters<typeof client.models.generateContent>[0]["contents"],
          config: {
            responseMimeType: "application/json",
            maxOutputTokens: MAX_OUTPUT_TOKENS_GEMINI,
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                partNumber: { type: Type.INTEGER },
                questions: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      questionNumber: { type: Type.INTEGER },
                      passage: { type: Type.STRING },
                      questionText: { type: Type.STRING },
                      options: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            letter: { type: Type.STRING },
                            text: { type: Type.STRING },
                          },
                          required: ["letter", "text"],
                        },
                      },
                      correctAnswer: { type: Type.STRING },
                      transcript: { type: Type.STRING },
                    },
                    required: ["questionNumber", "questionText", "options", "correctAnswer"],
                  },
                },
              },
              required: ["partNumber", "questions"],
            },
          },
        });
      },
    },
    (text) => safeParseJson<ParsedExamData>(text, "parseToeicContent"),
    buildToeicAiOptions("parseToeicContent", aiStep)
  );
}

// ---------------------------------------------------------------------------
// Text regions
// ---------------------------------------------------------------------------

export async function extractTextRegionsFromImage(
  imageBase64: string,
  mimeType: string,
  aiStep?: PipelineStepState
): Promise<TextRegion[]> {
  const prompt = `You are analyzing a TOEIC reading passage image for interactive vocabulary selection.
Identify clickable word or short phrase regions (1-3 words max per region) from the main passage body text.

Rules:
- Return a JSON array of objects: { "id": "r1", "text": "word", "bbox": [x, y, w, h] }
- bbox values are normalized 0-1 relative to image width/height (x=left, y=top, w=width, h=height)
- Include meaningful vocabulary words and short phrases users might want to study
- Skip question numbers, part headers, page numbers, watermarks, and answer option labels
- Aim for 15-60 regions depending on passage length
- ids must be unique strings like "r1", "r2", ...

Output strictly valid JSON array only.`;

  return generateJsonWithDualProviders(
    "extractTextRegionsFromImage",
    {
      alibaba: () =>
        alibabaChatJsonWithVision([alibabaImageMessage(imageBase64, mimeType, prompt)], {
          name: "TextRegions",
          schema: TEXT_REGIONS_JSON_SCHEMA as unknown as Record<string, unknown>,
        }),
      openai: (model) =>
        openaiChatJson(model, [openaiImageMessage(imageBase64, mimeType, prompt)], {
          name: "TextRegions",
          schema: TEXT_REGIONS_JSON_SCHEMA as unknown as Record<string, unknown>,
        }),
      gemini: (model) =>
        getGeminiClient().models.generateContent({
          model,
          contents: {
            parts: [
              { inlineData: { data: imageBase64, mimeType } },
              { text: prompt },
            ],
          },
          config: {
            responseMimeType: "application/json",
            maxOutputTokens: MAX_OUTPUT_TOKENS_GEMINI,
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  text: { type: Type.STRING },
                  bbox: {
                    type: Type.ARRAY,
                    items: { type: Type.NUMBER },
                  },
                },
                required: ["id", "text", "bbox"],
              },
            },
          },
        }),
    },
    (text) => {
      const parsed = safeParseJson<TextRegion[]>(text, "extractTextRegionsFromImage");
      return parsed
        .filter(
          (r) =>
            r.id &&
            r.text?.trim() &&
            Array.isArray(r.bbox) &&
            r.bbox.length === 4 &&
            r.bbox.every((n) => typeof n === "number" && n >= 0 && n <= 1)
        )
        .map((r) => ({
          id: r.id,
          text: r.text.trim(),
          bbox: r.bbox as [number, number, number, number],
        }));
    },
    buildToeicAiOptions("extractTextRegionsFromImage", aiStep)
  );
}

export interface DetectGroupImageBboxInput {
  partNumber: number;
  questionNumbers: number[];
  passageSnippet?: string;
}

function parseImageBboxResponse(text: string): NormalizedBbox {
  const parsed = safeParseJson<{ imageBbox?: number[] }>(text, "detectGroupImageBbox");
  const raw = parsed.imageBbox;
  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new Error("detectGroupImageBbox: missing imageBbox array");
  }
  const nums = raw.map((n) => Number(n));
  if (nums.some((n) => !Number.isFinite(n))) {
    throw new Error("detectGroupImageBbox: invalid bbox numbers");
  }
  let [x, y, w, h] = nums as NormalizedBbox;
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  w = Math.max(0.02, Math.min(1 - x, w));
  h = Math.max(0.02, Math.min(1 - y, h));
  return [x, y, w, h];
}

export async function detectGroupImageBbox(
  imageBase64: string,
  mimeType: string,
  input: DetectGroupImageBboxInput,
  aiStep?: PipelineStepState
): Promise<NormalizedBbox> {
  const qList = input.questionNumbers.join(", ");
  const snippet =
    input.passageSnippet && input.passageSnippet.length > 0
      ? `\nPassage hint (first lines):\n${input.passageSnippet.slice(0, 500)}`
      : "";

  const isPhoto = input.partNumber === 1;
  const prompt = isPhoto
    ? `You are locating a TOEIC Part 1 photograph on an exam page image.
Questions on this page for this crop: ${qList}.
Return JSON: { "imageBbox": [x, y, w, h] } with normalized 0-1 coordinates on the FULL page image.
The box must tightly contain ONLY the photograph for question ${input.questionNumbers[0]} (not headers, not A-D option text).`
    : `You are locating a TOEIC Part ${input.partNumber} reading passage on an exam page image.
Questions in this passage group: ${qList}.${snippet}
Return JSON: { "imageBbox": [x, y, w, h] } with normalized 0-1 coordinates on the FULL page image.
The box must contain ONLY the shared passage text block (not questions, not answer options, not part headers).`;

  return generateJsonWithDualProviders(
    "detectGroupImageBbox",
    {
      alibaba: () =>
        alibabaChatJsonWithVision([alibabaImageMessage(imageBase64, mimeType, prompt)], {
          name: "ImageBbox",
          schema: IMAGE_BBOX_JSON_SCHEMA as unknown as Record<string, unknown>,
        }),
      openai: (model) =>
        openaiChatJson(model, [openaiImageMessage(imageBase64, mimeType, prompt)], {
          name: "ImageBbox",
          schema: IMAGE_BBOX_JSON_SCHEMA as unknown as Record<string, unknown>,
        }),
      gemini: (model) =>
        getGeminiClient().models.generateContent({
          model,
          contents: {
            parts: [
              { inlineData: { data: imageBase64, mimeType } },
              { text: prompt },
            ],
          },
          config: {
            responseMimeType: "application/json",
            maxOutputTokens: MAX_OUTPUT_TOKENS_GEMINI,
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                imageBbox: {
                  type: Type.ARRAY,
                  items: { type: Type.NUMBER },
                },
              },
              required: ["imageBbox"],
            },
          },
        }),
    },
    parseImageBboxResponse,
    buildToeicAiOptions("detectGroupImageBbox", aiStep)
  );
}

// ---------------------------------------------------------------------------
// Classify files
// ---------------------------------------------------------------------------

export async function classifyToeicFileRoles(
  files: Array<{ fileName: string; mimeType: string; textSample: string }>,
  aiStep?: PipelineStepState
): Promise<FileRolePrediction[]> {
  const content = JSON.stringify(files);
  const prompt = `Classify each input file into one role for TOEIC import pipeline:
- EXAM_DOC
- LISTENING_KEY_DOC
- READING_KEY_IMAGE
- AUDIO_FILE
- UNKNOWN

Return strict JSON array with fields: fileName, role, confidence (0..1), reason.
Do not invent new file names.`;

  const fullPrompt = `${prompt}\n\nFILES:\n${content}`;

  const classifySchema = {
    name: "FileRolePredictions",
    schema: FILE_ROLE_JSON_SCHEMA as unknown as Record<string, unknown>,
  };
  const classifyMessages = [{ role: "user" as const, content: fullPrompt }];

  return generateJsonWithDualProviders(
    "classifyToeicFileRoles",
    {
      ...compatibleChatHandlers(classifyMessages, classifySchema, "classifyToeicFileRoles"),
      gemini: (model) =>
        getGeminiClient().models.generateContent({
          model,
          contents: fullPrompt,
          config: {
            responseMimeType: "application/json",
            maxOutputTokens: 4096,
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  fileName: { type: Type.STRING },
                  role: { type: Type.STRING },
                  confidence: { type: Type.NUMBER },
                  reason: { type: Type.STRING },
                },
                required: ["fileName", "role", "confidence", "reason"],
              },
            },
          },
        }),
    },
    (text) => safeParseJson<FileRolePrediction[]>(text, "classifyToeicFileRoles"),
    buildToeicAiOptions("classifyToeicFileRoles", aiStep)
  );
}

/** @deprecated Use getProviderOrder from dualProvider — kept for compatibility */
export { getGeminiModelChain as getModelChain } from "./ai/geminiProvider.js";
