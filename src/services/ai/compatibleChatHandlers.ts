import type OpenAI from "openai";
import { alibabaChatJson } from "./alibabaProvider.js";
import { deepseekChatJson } from "./deepseekProvider.js";
import type { ProviderHandlers } from "./dualProvider.js";
import type { OpenAIJsonSchemaConfig } from "./openaiProvider.js";
import { openaiChatJson } from "./openaiProvider.js";

/** Alibaba + OpenAI + DeepSeek chat handlers (OpenAI-compatible APIs). */
export function compatibleChatHandlers(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  schema?: OpenAIJsonSchemaConfig,
  label?: string
): Pick<ProviderHandlers, "alibaba" | "openai" | "deepseek"> {
  return {
    alibaba: (model) => alibabaChatJson(model, messages, schema, label),
    openai: (model) => openaiChatJson(model, messages, schema, label),
    deepseek: (model) => deepseekChatJson(model, messages, schema, label),
  };
}
