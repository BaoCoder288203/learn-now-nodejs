import OpenAI from "openai";
import {
  extractRetryDelayMs,
  getErrorMessage,
  isQuotaExhausted,
  shouldRetrySameModel,
  sleep,
} from "./jsonUtils.js";
import type { OpenAIJsonSchemaConfig } from "./openaiProvider.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
const DEFAULT_DEEPSEEK_FALLBACKS = "deepseek-v4-pro";
const MAX_OUTPUT_TOKENS = Number(process.env.DEEPSEEK_MAX_OUTPUT_TOKENS) || 8192;
const MAX_RETRY_ATTEMPTS = 4;

let deepseekClient: OpenAI | null = null;
let cachedDeepseekChain: string[] | null = null;

export function isDeepseekConfigured(): boolean {
  return !!process.env.DEEPSEEK_API_KEY?.trim();
}

export function getDeepseekClient(): OpenAI {
  if (!deepseekClient) {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("DEEPSEEK_API_KEY environment variable is required.");
    }
    const baseURL = (process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
    deepseekClient = new OpenAI({ apiKey, baseURL });
  }
  return deepseekClient;
}

export function getDeepseekModelChain(): string[] {
  if (cachedDeepseekChain) return cachedDeepseekChain;

  const fallbacksRaw =
    process.env.DEEPSEEK_MODEL_FALLBACKS?.trim() || DEFAULT_DEEPSEEK_FALLBACKS;
  const fallbacks = fallbacksRaw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  cachedDeepseekChain = [...new Set([DEEPSEEK_MODEL, ...fallbacks])];
  return cachedDeepseekChain;
}

export async function generateJsonWithDeepseek<T>(
  label: string,
  run: (model: string) => Promise<{ text?: string | null }>,
  parse: (text: string) => T
): Promise<T> {
  const models = getDeepseekModelChain();
  let lastError: unknown;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex]!;
    const nextModel = models[modelIndex + 1];

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await run(model);
        const text = response.text || "";
        if (!text.trim()) {
          throw new Error(`${label}: DeepSeek trả về response rỗng.`);
        }
        const result = parse(text);
        if (modelIndex > 0) {
          console.log(`[DeepSeek] ${label}: thành công với model ${model}`);
        }
        return result;
      } catch (error) {
        lastError = error;
        const shortMsg = getErrorMessage(error).slice(0, 200);

        if (isQuotaExhausted(error)) {
          if (nextModel) {
            console.warn(
              `[DeepSeek] ${label}: model ${model} hết quota — chuyển sang ${nextModel}. (${shortMsg})`
            );
            break;
          }
          throw error;
        }

        if (shouldRetrySameModel(error) && attempt < MAX_RETRY_ATTEMPTS) {
          const delayMs = extractRetryDelayMs(error) ?? 2000 * attempt;
          console.warn(
            `[DeepSeek] ${label} (${model}) lần ${attempt}/${MAX_RETRY_ATTEMPTS}, thử lại sau ${delayMs}ms: ${shortMsg}`
          );
          await sleep(delayMs);
          continue;
        }

        if (nextModel) {
          console.warn(
            `[DeepSeek] ${label}: model ${model} thất bại — chuyển sang ${nextModel}. (${shortMsg})`
          );
          break;
        }

        throw error;
      }
    }
  }

  throw new Error(
    `${label}: DeepSeek tất cả model đều thất bại (${models.join(" → ")}). Lỗi cuối: ${getErrorMessage(lastError)}`
  );
}

/** DeepSeek: json_object (OpenAI-compatible); strict json_schema may not be supported. */
export async function deepseekChatJson(
  model: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  _schema?: OpenAIJsonSchemaConfig,
  headroomLabel?: string
): Promise<{ text?: string | null }> {
  const { chatCompletionsJson } = await import("./openaiCompatibleChat.js");
  return chatCompletionsJson(getDeepseekClient(), model, messages, _schema, {
    forceJsonObject: true,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    headroomLabel,
  });
}
