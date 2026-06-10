import OpenAI from "openai";
import {
  extractRetryDelayMs,
  getErrorMessage,
  isQuotaExhausted,
  shouldRetrySameModel,
  sleep,
} from "./jsonUtils.js";

const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
const DEFAULT_OPENAI_FALLBACKS = "gpt-4o,gpt-4.1";
const MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS) || 16384;
const MAX_RETRY_ATTEMPTS = 4;

let openaiClient: OpenAI | null = null;
let cachedOpenaiChain: string[] | null = null;

export function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is required.");
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

export function getOpenAIModelChain(): string[] {
  if (cachedOpenaiChain) return cachedOpenaiChain;

  const fallbacksRaw = process.env.OPENAI_MODEL_FALLBACKS?.trim() || DEFAULT_OPENAI_FALLBACKS;
  const fallbacks = fallbacksRaw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  cachedOpenaiChain = [...new Set([OPENAI_MODEL, ...fallbacks])];
  return cachedOpenaiChain;
}

export interface OpenAIJsonSchemaConfig {
  name: string;
  schema: Record<string, unknown>;
}

export async function generateJsonWithOpenAI<T>(
  label: string,
  run: (model: string) => Promise<{ text?: string | null }>,
  parse: (text: string) => T
): Promise<T> {
  const models = getOpenAIModelChain();
  let lastError: unknown;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex]!;
    const nextModel = models[modelIndex + 1];

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await run(model);
        const text = response.text || "";
        if (!text.trim()) {
          throw new Error(`${label}: OpenAI trả về response rỗng.`);
        }
        const result = parse(text);
        if (modelIndex > 0) {
          console.log(`[OpenAI] ${label}: thành công với model ${model}`);
        }
        return result;
      } catch (error) {
        lastError = error;
        const shortMsg = getErrorMessage(error).slice(0, 200);

        if (isQuotaExhausted(error)) {
          if (nextModel) {
            console.warn(
              `[OpenAI] ${label}: model ${model} hết quota — chuyển sang ${nextModel}. (${shortMsg})`
            );
            break;
          }
          throw error;
        }

        if (shouldRetrySameModel(error) && attempt < MAX_RETRY_ATTEMPTS) {
          const delayMs = extractRetryDelayMs(error) ?? 2000 * attempt;
          console.warn(
            `[OpenAI] ${label} (${model}) lần ${attempt}/${MAX_RETRY_ATTEMPTS}, thử lại sau ${delayMs}ms: ${shortMsg}`
          );
          await sleep(delayMs);
          continue;
        }

        if (nextModel) {
          console.warn(
            `[OpenAI] ${label}: model ${model} thất bại — chuyển sang ${nextModel}. (${shortMsg})`
          );
          break;
        }

        throw error;
      }
    }
  }

  throw new Error(
    `${label}: OpenAI tất cả model đều thất bại (${models.join(" → ")}). Lỗi cuối: ${getErrorMessage(lastError)}`
  );
}

export function openaiTextResponseFormat(schema?: OpenAIJsonSchemaConfig) {
  if (schema) {
    return {
      type: "json_schema" as const,
      json_schema: {
        name: schema.name,
        strict: true,
        schema: schema.schema,
      },
    };
  }
  return { type: "json_object" as const };
}

export async function openaiChatJson(
  model: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  schema?: OpenAIJsonSchemaConfig,
  headroomLabel?: string
): Promise<{ text?: string | null }> {
  const { chatCompletionsJson } = await import("./openaiCompatibleChat.js");
  return chatCompletionsJson(getOpenAIClient(), model, messages, schema, {
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    headroomLabel,
  });
}

export function openaiImageMessage(
  imageBase64: string,
  mimeType: string,
  prompt: string
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  return {
    role: "user",
    content: [
      { type: "text", text: prompt },
      {
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${imageBase64}`,
        },
      },
    ],
  };
}
