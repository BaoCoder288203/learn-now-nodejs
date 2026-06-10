import OpenAI from "openai";
import {
  extractRetryDelayMs,
  getErrorMessage,
  isQuotaExhausted,
  shouldRetrySameModel,
  sleep,
} from "./jsonUtils.js";
import type { OpenAIJsonSchemaConfig } from "./openaiProvider.js";

const DEFAULT_BASE_URL =
  "https://ws-kdrebhkxfd4i6qvo.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const ALIBABA_MODEL = process.env.ALIBABA_MODEL?.trim() || "qwen-plus";
const DEFAULT_ALIBABA_FALLBACKS = "qwen-turbo,qwen-max";
const ALIBABA_VISION_MODEL = process.env.ALIBABA_VISION_MODEL?.trim() || "qwen-vl-plus";
const MAX_OUTPUT_TOKENS = Number(process.env.ALIBABA_MAX_OUTPUT_TOKENS) || 8192;
const MAX_RETRY_ATTEMPTS = 4;

let alibabaClient: OpenAI | null = null;
let cachedAlibabaChain: string[] | null = null;

export function isAlibabaConfigured(): boolean {
  return !!process.env.ALIBABA_API_KEY?.trim();
}

export function getAlibabaClient(): OpenAI {
  if (!alibabaClient) {
    const apiKey = process.env.ALIBABA_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("ALIBABA_API_KEY environment variable is required.");
    }
    const baseURL = (process.env.ALIBABA_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
    alibabaClient = new OpenAI({ apiKey, baseURL });
  }
  return alibabaClient;
}

export function getAlibabaModelChain(): string[] {
  if (cachedAlibabaChain) return cachedAlibabaChain;

  const fallbacksRaw =
    process.env.ALIBABA_MODEL_FALLBACKS?.trim() || DEFAULT_ALIBABA_FALLBACKS;
  const fallbacks = fallbacksRaw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  cachedAlibabaChain = [...new Set([ALIBABA_MODEL, ...fallbacks])];
  return cachedAlibabaChain;
}

export async function generateJsonWithAlibaba<T>(
  label: string,
  run: (model: string) => Promise<{ text?: string | null }>,
  parse: (text: string) => T
): Promise<T> {
  const models = getAlibabaModelChain();
  let lastError: unknown;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex]!;
    const nextModel = models[modelIndex + 1];

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await run(model);
        const text = response.text || "";
        if (!text.trim()) {
          throw new Error(`${label}: Alibaba/Qwen trả về response rỗng.`);
        }
        const result = parse(text);
        if (modelIndex > 0) {
          console.log(`[Alibaba] ${label}: thành công với model ${model}`);
        }
        return result;
      } catch (error) {
        lastError = error;
        const shortMsg = getErrorMessage(error).slice(0, 200);

        if (isQuotaExhausted(error)) {
          if (nextModel) {
            console.warn(
              `[Alibaba] ${label}: model ${model} hết quota — chuyển sang ${nextModel}. (${shortMsg})`
            );
            break;
          }
          throw error;
        }

        if (shouldRetrySameModel(error) && attempt < MAX_RETRY_ATTEMPTS) {
          const delayMs = extractRetryDelayMs(error) ?? 2000 * attempt;
          console.warn(
            `[Alibaba] ${label} (${model}) lần ${attempt}/${MAX_RETRY_ATTEMPTS}, thử lại sau ${delayMs}ms: ${shortMsg}`
          );
          await sleep(delayMs);
          continue;
        }

        if (nextModel) {
          console.warn(
            `[Alibaba] ${label}: model ${model} thất bại — chuyển sang ${nextModel}. (${shortMsg})`
          );
          break;
        }

        throw error;
      }
    }
  }

  throw new Error(
    `${label}: Alibaba tất cả model đều thất bại (${models.join(" → ")}). Lỗi cuối: ${getErrorMessage(lastError)}`
  );
}

/** DashScope compatible mode: json_object (structured schema may not be supported). */
export async function alibabaChatJson(
  model: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  _schema?: OpenAIJsonSchemaConfig,
  headroomLabel?: string
): Promise<{ text?: string | null }> {
  const { chatCompletionsJson } = await import("./openaiCompatibleChat.js");
  return chatCompletionsJson(getAlibabaClient(), model, messages, _schema, {
    forceJsonObject: true,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    headroomLabel,
  });
}

export function alibabaImageMessage(
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

export async function alibabaChatJsonWithVision(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  schema?: OpenAIJsonSchemaConfig
): Promise<{ text?: string | null }> {
  return alibabaChatJson(ALIBABA_VISION_MODEL, messages, schema);
}
