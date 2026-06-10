import { GoogleGenAI, Type } from "@google/genai";
import {
  extractRetryDelayMs,
  getErrorMessage,
  isQuotaExhausted,
  safeParseJson,
  shouldRetrySameModel,
  sleep,
} from "./jsonUtils.js";
import { SINGLE_PART_JSON_SCHEMA } from "./schemas.js";

const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
const DEFAULT_MODEL_FALLBACKS = "gemini-2.0-flash,gemini-2.0-flash-lite";
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 65536;
const MAX_RETRY_ATTEMPTS = 4;

let aiClient: GoogleGenAI | null = null;
let cachedModelChain: string[] | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required.");
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

export function getGeminiModelChain(): string[] {
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

export function buildGeminiSinglePartSchema() {
  return {
    type: Type.OBJECT as const,
    properties: {
      partNumber: { type: Type.INTEGER as const },
      groups: {
        type: Type.ARRAY as const,
        items: {
          type: Type.OBJECT as const,
          properties: {
            passage: { type: Type.STRING as const },
            transcript: { type: Type.STRING as const },
            sourcePage: { type: Type.INTEGER as const },
            imageBbox: {
              type: Type.ARRAY as const,
              items: { type: Type.NUMBER as const },
            },
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

export async function generateJsonWithGemini<T>(
  label: string,
  run: (model: string) => Promise<{ text?: string | null }>,
  parse: (text: string) => T
): Promise<T> {
  const models = getGeminiModelChain();
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
    `${label}: Gemini tất cả model đều thất bại (${models.join(" → ")}). Lỗi cuối: ${getErrorMessage(lastError)}`
  );
}

export { SINGLE_PART_JSON_SCHEMA, safeParseJson };
