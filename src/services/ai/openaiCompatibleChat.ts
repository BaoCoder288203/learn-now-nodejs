import type OpenAI from "openai";
import { maybeCompressChatMessages, messagesHaveVision } from "./headroomCompress.js";
import { AiPartialOutputError } from "./jsonUtils.js";
import type { OpenAIJsonSchemaConfig } from "./openaiProvider.js";
import { openaiTextResponseFormat } from "./openaiProvider.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export function isAiStreamingEnabled(): boolean {
  const raw = process.env.AI_ENABLE_STREAMING?.trim().toLowerCase();
  return raw !== "false" && raw !== "0";
}

export async function chatCompletionsJson(
  client: OpenAI,
  model: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  schema?: OpenAIJsonSchemaConfig,
  opts?: { forceJsonObject?: boolean; maxOutputTokens?: number; headroomLabel?: string }
): Promise<{ text?: string | null }> {
  const maxTokens = opts?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const payload = await maybeCompressChatMessages(messages, model, opts?.headroomLabel);
  const useStream = isAiStreamingEnabled() && !messagesHaveVision(payload);

  if (!useStream) {
    const response = await client.chat.completions.create({
      model,
      messages: payload,
      max_tokens: maxTokens,
      response_format: opts?.forceJsonObject
        ? { type: "json_object" }
        : openaiTextResponseFormat(schema),
    });
    return { text: response.choices[0]?.message?.content ?? "" };
  }

  const stream = await client.chat.completions.create({
    model,
    messages: payload,
    max_tokens: maxTokens,
    stream: true,
    response_format: opts?.forceJsonObject
      ? { type: "json_object" }
      : openaiTextResponseFormat(schema),
  });

  let text = "";
  let finishReason: string | undefined;

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (choice?.delta?.content) {
      text += choice.delta.content;
    }
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  if (finishReason === "length" && text.trim()) {
    throw new AiPartialOutputError(
      text,
      `Output truncated (finish_reason=length), length=${text.length}`
    );
  }

  return { text };
}
