import type { GenerateJsonOptions, ProviderRunFn } from "./dualProvider.js";
import type { AiProviderName } from "./types.js";
import { alibabaChatJson } from "./alibabaProvider.js";
import { deepseekChatJson } from "./deepseekProvider.js";
import { getGeminiClient } from "./geminiProvider.js";
import { openaiChatJson } from "./openaiProvider.js";
import type { PipelineStepState } from "../importPipelineState.js";
import { buildContinuationPrompt, type AiResumeContext } from "./resumeContext.js";

export function buildToeicAiOptions(
  label: string,
  stepState?: PipelineStepState
): GenerateJsonOptions | undefined {
  const partial = stepState?.partialText;
  const resume: AiResumeContext | undefined = partial
    ? { mode: "continue_json", partialText: partial }
    : undefined;

  if (!resume && stepState?.status !== "failed") {
    return undefined;
  }

  return {
    resume,
    buildContinuationRun: (partialText: string, provider: AiProviderName): ProviderRunFn => {
      const prompt = buildContinuationPrompt(label, partialText);
      const msg = [{ role: "user" as const, content: prompt }];

      if (provider === "alibaba") {
        return (model) => alibabaChatJson(model, msg, undefined, label);
      }
      if (provider === "openai") {
        return (model) => openaiChatJson(model, msg, undefined, label);
      }
      if (provider === "deepseek") {
        return (model) => deepseekChatJson(model, msg, undefined, label);
      }
      return (model) =>
        getGeminiClient().models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: "application/json" },
        });
    },
  };
}
