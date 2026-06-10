import type { AiProviderName } from "./types.js";
import { generateJsonWithAlibaba, isAlibabaConfigured } from "./alibabaProvider.js";
import { generateJsonWithDeepseek, isDeepseekConfigured } from "./deepseekProvider.js";
import { generateJsonWithGemini } from "./geminiProvider.js";
import { generateJsonWithOpenAI } from "./openaiProvider.js";
import {
  AiPartialOutputError,
  getErrorMessage,
  isJsonParseFailure,
  shouldFallbackProvider,
} from "./jsonUtils.js";
import type { AiResumeContext } from "./resumeContext.js";

export type ProviderRunFn = (model: string) => Promise<{ text?: string | null }>;

export interface ProviderHandlers {
  alibaba?: ProviderRunFn;
  openai?: ProviderRunFn;
  deepseek?: ProviderRunFn;
  gemini?: ProviderRunFn;
}

/** @deprecated Use ProviderHandlers */
export type DualProviderHandlers = ProviderHandlers;

export interface GenerateJsonOptions {
  resume?: AiResumeContext;
  /** Override env provider order for this call (e.g. openai first for large Part 7). */
  providerOrder?: AiProviderName[];
  /** Builds provider-specific run using continuation prompt (saves tokens vs full re-prompt). */
  buildContinuationRun?: (partialText: string, provider: AiProviderName) => ProviderRunFn;
}

const DEFAULT_PROVIDER_ORDER: AiProviderName[] = [
  "gemini",
  "openai",
  "alibaba",
];

function hasProviderKey(name: AiProviderName): boolean {
  switch (name) {
    case "alibaba":
      return isAlibabaConfigured();
    case "openai":
      return !!process.env.OPENAI_API_KEY?.trim();
    case "deepseek":
      return isDeepseekConfigured();
    case "gemini":
      return !!process.env.GEMINI_API_KEY?.trim();
    default:
      return false;
  }
}

function parseProviderOrderFromEnv(): AiProviderName[] | null {
  const raw = process.env.AI_PROVIDER_ORDER?.trim();
  if (!raw) return null;

  const valid = new Set<AiProviderName>(["alibaba", "openai", "deepseek", "gemini"]);
  const parsed = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is AiProviderName => valid.has(p as AiProviderName));

  return parsed.length ? parsed : null;
}

export function getProviderOrder(): AiProviderName[] {
  const mode = (process.env.AI_PROVIDER?.trim() || "auto").toLowerCase();

  if (mode === "alibaba") {
    return hasProviderKey("alibaba") ? ["alibaba"] : fallbackChainExcluding("alibaba");
  }
  if (mode === "deepseek") {
    return hasProviderKey("deepseek") ? ["deepseek"] : fallbackChainExcluding("deepseek");
  }
  if (mode === "openai") {
    return hasProviderKey("openai") ? ["openai"] : fallbackChainExcluding("openai");
  }
  if (mode === "gemini") {
    return hasProviderKey("gemini") ? ["gemini"] : fallbackChainExcluding("gemini");
  }

  const template = parseProviderOrderFromEnv() ?? DEFAULT_PROVIDER_ORDER;
  return template.filter((name) => hasProviderKey(name));
}

function fallbackChainExcluding(exclude: AiProviderName): AiProviderName[] {
  return DEFAULT_PROVIDER_ORDER.filter((name) => name !== exclude && hasProviderKey(name));
}

export function logProviderOrderAtStartup(): void {
  const order = getProviderOrder();
  if (!order.length) {
    console.warn(
      "[AI] Chưa cấu hình provider nào (cần ALIBABA_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY hoặc GEMINI_API_KEY)."
    );
    return;
  }
  console.log(`[AI] Provider order (${process.env.AI_PROVIDER || "auto"}): ${order.join(" → ")}`);
}

async function runProvider<T>(
  provider: AiProviderName,
  label: string,
  run: ProviderRunFn,
  parse: (text: string) => T
): Promise<T> {
  if (provider === "alibaba") {
    return generateJsonWithAlibaba(label, run, parse);
  }
  if (provider === "openai") {
    return generateJsonWithOpenAI(label, run, parse);
  }
  if (provider === "deepseek") {
    return generateJsonWithDeepseek(label, run, parse);
  }
  return generateJsonWithGemini(label, run, parse);
}

function extractPartialFromError(error: unknown): string | undefined {
  if (error instanceof AiPartialOutputError) {
    return error.partialText;
  }
  return undefined;
}

export async function generateJsonWithDualProviders<T>(
  label: string,
  handlers: ProviderHandlers,
  parse: (text: string) => T,
  options?: GenerateJsonOptions
): Promise<T> {
  const envOrder = getProviderOrder();
  const override = options?.providerOrder?.filter((name) => handlers[name]);
  const resolvedOrder = override?.length ? override : envOrder;
  if (!resolvedOrder.length) {
    throw new Error(
      "Chưa cấu hình AI provider: cần ALIBABA_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY hoặc GEMINI_API_KEY trong .env."
    );
  }

  let lastError: unknown;
  let carryPartial: string | undefined = options?.resume?.partialText;
  let startIndex = 0;

  if (options?.resume?.mode === "continue_json" && carryPartial) {
    console.log(`[AI] ${label}: tiếp tục từ partial (${carryPartial.length} chars).`);
    startIndex = 0;
  }

  for (let i = startIndex; i < resolvedOrder.length; i++) {
    const provider = resolvedOrder[i]!;
    const useContinuation = !!carryPartial && !!options?.buildContinuationRun;
    const run = useContinuation
      ? options!.buildContinuationRun!(carryPartial!, provider)
      : handlers[provider];

    if (!run) {
      console.warn(`[AI] ${label}: bỏ qua ${provider} (không có handler).`);
      continue;
    }

    try {
      const result = await runProvider(provider, label, run, parse);

      if (i > 0 || carryPartial) {
        console.log(`[AI] ${label}: thành công với provider ${provider}${carryPartial ? " (continuation)" : " (fallback)"}.`);
      }
      return result;
    } catch (error) {
      lastError = error;
      const partial = extractPartialFromError(error);
      const hasNext = i < resolvedOrder.length - 1;

      if (partial && options?.buildContinuationRun) {
        carryPartial = partial;
      }

      const canFallback =
        hasNext &&
        (shouldFallbackProvider(error) ||
          isJsonParseFailure(error) ||
          error instanceof AiPartialOutputError);

      if (canFallback) {
        console.warn(
          `[AI] ${label}: ${provider} thất bại — chuyển sang ${resolvedOrder[i + 1]}${carryPartial ? " (partial handoff)" : ""}. (${getErrorMessage(error).slice(0, 180)})`
        );
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `${label}: không có provider khả dụng. Lỗi cuối: ${getErrorMessage(lastError)}`
  );
}
