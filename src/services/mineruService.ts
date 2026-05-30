export interface MineruParseResult {
  text: string;
  provider: "mineru" | "fallback";
  raw?: unknown;
}

function getMineruBaseUrl(): string {
  return process.env.MINERU_BASE_URL?.trim() || "http://localhost:8000";
}

function getMineruTimeoutMs(): number {
  const parsed = Number(process.env.MINERU_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 120_000;
}

function getMineruBackend(): string {
  return process.env.MINERU_BACKEND?.trim() || "pipeline";
}

function extractTextFromMineruResponse(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;

  const results = obj.results;
  if (results && typeof results === "object") {
    const parts: string[] = [];
    for (const fileResult of Object.values(results as Record<string, unknown>)) {
      if (!fileResult || typeof fileResult !== "object") continue;
      const entry = fileResult as Record<string, unknown>;
      if (typeof entry.md_content === "string" && entry.md_content.trim()) {
        parts.push(entry.md_content);
      } else if (typeof entry.content_list === "string" && entry.content_list.trim()) {
        parts.push(entry.content_list);
      }
    }
    if (parts.length) return parts.join("\n\n");
  }

  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.markdown === "string") return obj.markdown;
  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.blocks)) {
    const lines = obj.blocks
      .map((b) => {
        if (!b || typeof b !== "object") return "";
        const block = b as Record<string, unknown>;
        return typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean);
    return lines.join("\n");
  }
  return "";
}

export async function parseDocumentWithMineru(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<MineruParseResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getMineruTimeoutMs());

  try {
    const formData = new FormData();
    formData.append("files", new Blob([fileBuffer], { type: mimeType }), fileName);
    formData.append("return_md", "true");
    formData.append("backend", getMineruBackend());
    formData.append("lang_list", process.env.MINERU_LANG_LIST?.trim() || "en");

    const response = await fetch(`${getMineruBaseUrl()}/file_parse`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`MinerU HTTP ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as unknown;
    const text = extractTextFromMineruResponse(payload);
    if (!text.trim()) {
      throw new Error("MinerU không trả về text parse hợp lệ.");
    }

    return { text, provider: "mineru", raw: payload };
  } finally {
    clearTimeout(timeout);
  }
}
