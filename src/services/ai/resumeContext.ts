import type { AiProviderName } from "./types.js";

export type AiResumeMode = "full" | "continue_json";

export interface AiResumeContext {
  partialText?: string;
  fromProvider?: AiProviderName;
  mode: AiResumeMode;
}

export function buildContinuationPrompt(label: string, partialText: string): string {
  const trimmed = partialText.trim();
  const excerpt =
    trimmed.length > 120_000 ? `${trimmed.slice(0, 120_000)}\n...[truncated]` : trimmed;

  return `You are continuing a previous AI task that was interrupted (${label}).
The previous model produced INCOMPLETE JSON. Complete and fix it so it is strictly valid JSON.

Rules:
- Output ONLY valid JSON (no markdown fences, no commentary).
- Preserve all correct partial content from the fragment below.
- Fill in missing fields, close arrays/objects, and fix syntax errors.
- Do not repeat the full original document; only output the completed JSON.

--- INCOMPLETE JSON FROM PREVIOUS MODEL ---
${excerpt}
--- END INCOMPLETE JSON ---`;
}
