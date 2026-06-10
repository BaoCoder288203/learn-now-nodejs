import { compress } from "headroom-ai";
import type OpenAI from "openai";

export function isHeadroomEnabled(): boolean {
  const flag = process.env.HEADROOM_ENABLED?.trim().toLowerCase();
  if (flag === "false" || flag === "0") return false;
  const url = process.env.HEADROOM_BASE_URL?.trim();
  return !!url;
}

export function getHeadroomBaseUrl(): string {
  return (process.env.HEADROOM_BASE_URL?.trim() || "http://localhost:8787").replace(/\/$/, "");
}

export function messagesHaveVision(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => typeof p === "object" && p !== null && "image_url" in p)
  );
}

function messagesCharLength(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      n += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p === "object" && p !== null && "text" in p && typeof p.text === "string") {
          n += p.text.length;
        }
      }
    }
  }
  return n;
}

/**
 * Compress text-only chat messages via Headroom proxy before LLM calls.
 * Skips vision payloads and short prompts (HEADROOM_MIN_CHARS).
 */
export async function maybeCompressChatMessages(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  model: string,
  label?: string
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
  if (!isHeadroomEnabled() || messagesHaveVision(messages)) {
    return messages;
  }

  const minChars = Number(process.env.HEADROOM_MIN_CHARS) || 2000;
  if (messagesCharLength(messages) < minChars) {
    return messages;
  }

  const tokenBudgetRaw = process.env.HEADROOM_TOKEN_BUDGET?.trim();
  const tokenBudget = tokenBudgetRaw ? Number(tokenBudgetRaw) : undefined;

  try {
    const result = await compress(messages, {
      model,
      baseUrl: getHeadroomBaseUrl(),
      apiKey: process.env.HEADROOM_API_KEY?.trim(),
      timeout: Number(process.env.HEADROOM_TIMEOUT_MS) || 60_000,
      fallback: true,
      retries: 1,
      ...(tokenBudget && Number.isFinite(tokenBudget) ? { tokenBudget } : {}),
    });

    if (result.tokensSaved > 0) {
      console.log(
        `[Headroom] ${label ?? "chat"}: saved ${result.tokensSaved} tokens (${result.tokensBefore} → ${result.tokensAfter})`
      );
    }

    return result.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  } catch (error) {
    console.warn(
      "[Headroom] compress failed, using original messages:",
      error instanceof Error ? error.message : error
    );
    return messages;
  }
}
