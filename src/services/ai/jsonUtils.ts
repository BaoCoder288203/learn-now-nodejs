export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function safeParseJson<T>(text: string, label: string): T {
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

export function isQuotaExhausted(error: unknown): boolean {
  const err = error as { status?: number };
  if (err.status === 429 || err.status === 402) return true;
  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes("quota") ||
    msg.includes("resource_exhausted") ||
    msg.includes("exceeded your current quota") ||
    msg.includes("rate limit") ||
    msg.includes("insufficient_quota") ||
    msg.includes("insufficient balance")
  );
}

export function isServiceUnavailable(error: unknown): boolean {
  const err = error as { status?: number };
  if (err.status === 503) return true;
  const msg = getErrorMessage(error).toLowerCase();
  return msg.includes("unavailable") || msg.includes("high demand");
}

export function isJsonParseFailure(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes("json") ||
    msg.includes("unterminated string") ||
    msg.includes("unexpected token")
  );
}

export function shouldRetrySameModel(error: unknown): boolean {
  return isServiceUnavailable(error) || isJsonParseFailure(error);
}

export function extractRetryDelayMs(error: unknown): number | null {
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

export function isTransientNetworkError(error: unknown): boolean {
  const err = error as { code?: string; cause?: { code?: string } };
  const codes = [err.code, err.cause?.code].filter(Boolean).map(String);
  if (codes.some((c) => /^(UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE)$/i.test(c))) {
    return true;
  }
  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes("terminated") ||
    msg.includes("socket") ||
    msg.includes("other side closed") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("aborted")
  );
}

export function shouldFallbackProvider(error: unknown): boolean {
  if (isQuotaExhausted(error)) return true;
  if (isTransientNetworkError(error)) return true;
  const err = error as { status?: number };
  if (err.status === 401 || err.status === 403) return true;
  if (err.status && err.status >= 500) return true;
  const msg = getErrorMessage(error).toLowerCase();
  return msg.includes("invalid_api_key") || msg.includes("incorrect api key");
}

export function isTruncatedResponse(error: unknown): boolean {
  const err = error as { code?: string; finishReason?: string };
  if (err.code === "truncated_output" || err.finishReason === "length") return true;
  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes("max_tokens") ||
    msg.includes("maximum context") ||
    msg.includes("output length") ||
    msg.includes("truncated")
  );
}

export class AiPartialOutputError extends Error {
  readonly partialText: string;
  readonly finishReason?: string;

  constructor(partialText: string, message: string, finishReason?: string) {
    super(message);
    this.name = "AiPartialOutputError";
    this.partialText = partialText;
    this.finishReason = finishReason;
  }
}
