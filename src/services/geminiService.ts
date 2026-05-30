import { GoogleGenAI, Type } from "@google/genai";

const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
const DEFAULT_MODEL_FALLBACKS = "gemini-2.0-flash,gemini-2.0-flash-lite";
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 65536;
const MAX_RETRY_ATTEMPTS = 4;

let aiClient: GoogleGenAI | null = null;
let cachedModelChain: string[] | null = null;

function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required.");
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Primary model first, then fallbacks (deduplicated). */
export function getModelChain(): string[] {
  if (cachedModelChain) return cachedModelChain;

  const fallbacksRaw =
    process.env.GEMINI_MODEL_FALLBACKS?.trim() || DEFAULT_MODEL_FALLBACKS;
  const fallbacks = fallbacksRaw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  cachedModelChain = [...new Set([GEMINI_MODEL, ...fallbacks])];
  return cachedModelChain;
}

function isQuotaExhausted(error: unknown): boolean {
  const err = error as { status?: number };
  if (err.status === 429) return true;
  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes("quota") ||
    msg.includes("resource_exhausted") ||
    msg.includes("exceeded your current quota") ||
    msg.includes("rate limit")
  );
}

function isServiceUnavailable(error: unknown): boolean {
  const err = error as { status?: number };
  if (err.status === 503) return true;
  const msg = getErrorMessage(error).toLowerCase();
  return msg.includes("unavailable") || msg.includes("high demand");
}

function isJsonParseFailure(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes("json") ||
    msg.includes("unterminated string") ||
    msg.includes("unexpected token")
  );
}

/** Retry same model (503, transient JSON). */
function shouldRetrySameModel(error: unknown): boolean {
  return isServiceUnavailable(error) || isJsonParseFailure(error);
}

function extractRetryDelayMs(error: unknown): number | null {
  const msg = getErrorMessage(error);

  const secondsMatch = msg.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  if (secondsMatch?.[1]) {
    return Math.min(Math.ceil(parseFloat(secondsMatch[1]) * 1000), 120_000);
  }

  const retryDelayMatch = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (retryDelayMatch?.[1]) {
    return Math.min(Math.ceil(parseFloat(retryDelayMatch[1]) * 1000), 120_000);
  }

  return null;
}

function safeParseJson<T>(text: string, label: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch (firstErr) {
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch?.[1]) {
      try {
        return JSON.parse(fenceMatch[1].trim()) as T;
      } catch {
        /* fall through */
      }
    }
    const message = firstErr instanceof Error ? firstErr.message : String(firstErr);
    throw new Error(
      `${label}: JSON không hợp lệ (${message}). Độ dài response: ${trimmed.length} ký tự.`
    );
  }
}

async function generateJsonWithRetry<T>(
  label: string,
  run: (model: string) => Promise<{ text?: string | null }>,
  parse: (text: string) => T
): Promise<T> {
  const models = getModelChain();
  let lastError: unknown;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex]!;
    const nextModel = models[modelIndex + 1];

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await run(model);
        const text = response.text || "";
        if (!text.trim()) {
          throw new Error(`${label}: Gemini trả về response rỗng.`);
        }
        const result = parse(text);
        if (modelIndex > 0) {
          console.log(`[Gemini] ${label}: thành công với model ${model}`);
        }
        return result;
      } catch (error) {
        lastError = error;
        const shortMsg = getErrorMessage(error).slice(0, 200);

        if (isQuotaExhausted(error)) {
          if (nextModel) {
            console.warn(
              `[Gemini] ${label}: model ${model} hết quota — chuyển sang ${nextModel}. (${shortMsg})`
            );
            break;
          }
          throw error;
        }

        if (shouldRetrySameModel(error) && attempt < MAX_RETRY_ATTEMPTS) {
          const delayMs = extractRetryDelayMs(error) ?? 2000 * attempt;
          console.warn(
            `[Gemini] ${label} (${model}) lần ${attempt}/${MAX_RETRY_ATTEMPTS}, thử lại sau ${delayMs}ms: ${shortMsg}`
          );
          await sleep(delayMs);
          continue;
        }

        if (nextModel) {
          console.warn(
            `[Gemini] ${label}: model ${model} thất bại — chuyển sang ${nextModel}. (${shortMsg})`
          );
          break;
        }

        throw error;
      }
    }
  }

  throw new Error(
    `${label}: tất cả model đều thất bại (${models.join(" → ")}). Lỗi cuối: ${getErrorMessage(lastError)}`
  );
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ParsedOption {
  letter: string;
  text: string;
}

export interface ParsedQuestion {
  questionNumber: number;
  questionText: string;
  options: ParsedOption[];
  correctAnswer: string;
}

export interface ParsedGroup {
  passage?: string;
  transcript?: string;
  imageDescription?: string;
  questions: ParsedQuestion[];
}

export interface ParsedPart {
  partNumber: number;
  groups: ParsedGroup[];
}

export interface FileRolePrediction {
  fileName: string;
  role: "EXAM_DOC" | "LISTENING_KEY_DOC" | "READING_KEY_IMAGE" | "AUDIO_FILE" | "UNKNOWN";
  confidence: number;
  reason: string;
}

export interface RcAnswerMap {
  [questionNumber: string]: string;
}

interface PdfInlineData {
  data: string;
  mimeType: string;
}

// ---------------------------------------------------------------------------
// Call 1: Read RC answer key from image
// ---------------------------------------------------------------------------

export async function parseAnswerKeyImage(
  imageBase64: string,
  mimeType: string
): Promise<RcAnswerMap> {
  const client = getAiClient();

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

  return generateJsonWithRetry(
    "parseAnswerKeyImage",
    (model) =>
      client.models.generateContent({
        model,
        contents: {
          parts: [
            { inlineData: { data: imageBase64, mimeType } },
            { text: prompt },
          ],
        },
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      }),
    (text) => safeParseJson<RcAnswerMap>(text, "parseAnswerKeyImage")
  );
}

export async function parseAnswerKeyText(answerKeyText: string): Promise<RcAnswerMap> {
  const client = getAiClient();

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

  return generateJsonWithRetry(
    "parseAnswerKeyText",
    (model) =>
      client.models.generateContent({
        model,
        contents: prompt + "\n\n---ANSWER KEY TEXT---\n" + answerKeyText,
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      }),
    (text) => safeParseJson<RcAnswerMap>(text, "parseAnswerKeyText")
  );
}

// ---------------------------------------------------------------------------
// Call 2: Parse Listening — one Gemini call per part (1-4)
// ---------------------------------------------------------------------------

const LISTENING_PART_INSTRUCTIONS: Record<number, string> = {
  1: `Parse ONLY TOEIC Listening Part 1 (Photographs), questions 1-6.
- Create exactly 6 groups (1 question each).
- questionText: "What is the best description of the photograph?" for all.
- Extract 4 statement options A-D from the transcript for each question.
- Include correctAnswer for each question from the KEY section.`,
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

async function parseListeningPart(
  transcriptText: string,
  partNumber: 1 | 2 | 3 | 4,
  examPdfInline?: PdfInlineData
): Promise<ParsedPart> {
  const client = getAiClient();
  const partInstructions = LISTENING_PART_INSTRUCTIONS[partNumber];

  const prompt = `You are a TOEIC exam parser. Below is raw text from a "KEY LC + TRANSCRIPT" PDF.
IGNORE all Korean text.

${partInstructions}

Output a single JSON object with partNumber ${partNumber} and a groups array.
Keep transcript/passage strings concise; escape quotes properly in JSON.`;

  return generateJsonWithRetry(
    `parseListeningPart${partNumber}`,
    (model) =>
      client.models.generateContent({
        model,
        contents:
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
            : (prompt + "\n\n---RAW TEXT---\n" + transcriptText),
        config: {
          responseMimeType: "application/json",
          responseSchema: buildSinglePartSchema(),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      }),
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
    }
  );
}

export async function parseListeningContent(
  transcriptText: string,
  examPdfInline?: PdfInlineData
): Promise<ParsedPart[]> {
  const parts: ParsedPart[] = [];
  for (const partNumber of [1, 2, 3, 4] as const) {
    console.log(`[Gemini] Parsing Listening Part ${partNumber}...`);
    const part = await parseListeningPart(transcriptText, partNumber, examPdfInline);
    parts.push({ ...part, partNumber });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Call 3: Parse Reading — one Gemini call per part (5-7)
// ---------------------------------------------------------------------------

const READING_PART_INSTRUCTIONS: Record<number, string> = {
  5: `Parse ONLY TOEIC Reading Part 5 (Incomplete Sentences), questions 101-130.
- Create 30 groups (1 question each).
- questionText is the sentence with a blank.
- 4 options A-D; use the provided answer key for correctAnswer.`,
  6: `Parse ONLY TOEIC Reading Part 6 (Text Completion), questions 131-146.
- Create 4 groups (4 questions each).
- Put the shared passage in the group passage field.
- 4 options A-D per question; use the answer key for correctAnswer.`,
  7: `Parse ONLY TOEIC Reading Part 7 (Reading Comprehension), questions 147-200.
- Create groups by shared passage (2-5 questions per group).
- Put passage text in the group passage field.
- 4 options A-D per question; use the answer key for correctAnswer.`,
};

async function parseReadingPart(
  examText: string,
  rcAnswers: RcAnswerMap,
  partNumber: 5 | 6 | 7,
  examPdfInline?: PdfInlineData
): Promise<ParsedPart> {
  const client = getAiClient();
  const answersJson = JSON.stringify(rcAnswers);
  const partInstructions = READING_PART_INSTRUCTIONS[partNumber];

  const prompt = `You are a TOEIC exam parser. Below is raw text from the READING section of a TOEIC exam PDF.

Correct answer key (question number -> letter):
${answersJson}

${partInstructions}

Output a single JSON object with partNumber ${partNumber} and a groups array.
Escape quotes properly in JSON strings.`;

  return generateJsonWithRetry(
    `parseReadingPart${partNumber}`,
    (model) =>
      client.models.generateContent({
        model,
        contents:
          partNumber >= 6 && examPdfInline
            ? ({
                parts: [
                  {
                    text:
                      `${prompt}\n\n` +
                      `Use attached exam PDF visual layout to preserve passages/paragraph boundaries for this part.\n\n` +
                      `---EXAM TEXT---\n${examText}`,
                  },
                  { inlineData: examPdfInline },
                ],
              } as Parameters<typeof client.models.generateContent>[0]["contents"])
            : (prompt + "\n\n---EXAM TEXT---\n" + examText),
        config: {
          responseMimeType: "application/json",
          responseSchema: buildSinglePartSchema(),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      }),
    (text) => {
      const parsed = safeParseJson<ParsedPart | ParsedPart[]>(
        text,
        `parseReadingPart${partNumber}`
      );
      if (Array.isArray(parsed)) {
        const match = parsed.find((p) => p.partNumber === partNumber);
        if (match) return match;
        if (parsed.length === 1) return parsed[0]!;
        throw new Error(`parseReadingPart${partNumber}: không tìm thấy part ${partNumber} trong mảng.`);
      }
      return parsed;
    }
  );
}

export async function parseReadingContent(
  examText: string,
  rcAnswers: RcAnswerMap,
  examPdfInline?: PdfInlineData
): Promise<ParsedPart[]> {
  const parts: ParsedPart[] = [];
  for (const partNumber of [5, 6, 7] as const) {
    console.log(`[Gemini] Parsing Reading Part ${partNumber}...`);
    const part = await parseReadingPart(examText, rcAnswers, partNumber, examPdfInline);
    parts.push({ ...part, partNumber });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Legacy: single-call parse (kept for backward compatibility)
// ---------------------------------------------------------------------------

export interface ParsedExamData {
  partNumber: number;
  questions: {
    questionNumber: number;
    passage?: string;
    questionText: string;
    options: { letter: string; text: string }[];
    correctAnswer: string;
    transcript?: string;
  }[];
}

export async function parseToeicContent(
  ocrText: string,
  imageBufferBase64?: { data: string; mimeType: string }
): Promise<ParsedExamData> {
  const client = getAiClient();

  const prompt = `You are an exam content parser specialized ONLY in TOEIC exams.
Input: Raw OCR text extracted from image or PDF.
${ocrText ? `Raw OCR Text: "${ocrText}"` : ""}

Your tasks:
1. Detect TOEIC part number (1-7).
2. For each question: extract question text, options (A-D), correct answer.
3. Preserve original wording. Normalize OCR mistakes.
4. Output strictly valid JSON.`;

  let contents: unknown = prompt;
  if (imageBufferBase64) {
    contents = {
      parts: [
        { inlineData: { data: imageBufferBase64.data, mimeType: imageBufferBase64.mimeType } },
        { text: prompt },
      ],
    };
  }

  return generateJsonWithRetry(
    "parseToeicContent",
    (model) =>
      client.models.generateContent({
        model,
        contents: contents as Parameters<typeof client.models.generateContent>[0]["contents"],
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: MAX_OUTPUT_TOKENS,
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
      }),
    (text) => safeParseJson<ParsedExamData>(text, "parseToeicContent")
  );
}

// ---------------------------------------------------------------------------
// Schema builders
// ---------------------------------------------------------------------------

function buildSinglePartSchema() {
  return {
    type: Type.OBJECT as const,
    properties: {
      partNumber: { type: Type.INTEGER as const, description: "TOEIC part number" },
      groups: {
        type: Type.ARRAY as const,
        items: {
          type: Type.OBJECT as const,
          properties: {
            passage: { type: Type.STRING as const },
            transcript: { type: Type.STRING as const },
            questions: {
              type: Type.ARRAY as const,
              items: {
                type: Type.OBJECT as const,
                properties: {
                  questionNumber: { type: Type.INTEGER as const },
                  questionText: { type: Type.STRING as const },
                  options: {
                    type: Type.ARRAY as const,
                    items: {
                      type: Type.OBJECT as const,
                      properties: {
                        letter: { type: Type.STRING as const },
                        text: { type: Type.STRING as const },
                      },
                      required: ["letter", "text"],
                    },
                  },
                  correctAnswer: { type: Type.STRING as const },
                },
                required: ["questionNumber", "questionText", "options", "correctAnswer"],
              },
            },
          },
          required: ["questions"],
        },
      },
    },
    required: ["partNumber", "groups"],
  };
}

export async function classifyToeicFileRoles(
  files: Array<{ fileName: string; mimeType: string; textSample: string }>
): Promise<FileRolePrediction[]> {
  const client = getAiClient();
  const content = JSON.stringify(files);
  const prompt = `Classify each input file into one role for TOEIC import pipeline:
- EXAM_DOC
- LISTENING_KEY_DOC
- READING_KEY_IMAGE
- AUDIO_FILE
- UNKNOWN

Return strict JSON array with fields: fileName, role, confidence (0..1), reason.
Do not invent new file names.`;

  return generateJsonWithRetry(
    "classifyToeicFileRoles",
    (model) =>
      client.models.generateContent({
        model,
        contents: `${prompt}\n\nFILES:\n${content}`,
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
    (text) => safeParseJson<FileRolePrediction[]>(text, "classifyToeicFileRoles")
  );
}
