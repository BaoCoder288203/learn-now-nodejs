export const PART_RANGES: Record<number, { start: number; end: number; perGroup?: number }> = {
  1: { start: 1, end: 6 },
  2: { start: 7, end: 31 },
  3: { start: 32, end: 70, perGroup: 3 },
  4: { start: 71, end: 100, perGroup: 3 },
  5: { start: 101, end: 130 },
  6: { start: 131, end: 146, perGroup: 4 },
  7: { start: 147, end: 200 },
};

export const OPTION_LINE_RE =
  /^\s*\(?([A-D])\)?\s*[\.\)]\s*(.+)$/i;

/** Answer-key lines like `51 (A)` or `102 B` — not Part 1 photo statements. */
export const LC_ANSWER_KEY_LINE_RE =
  /^\s*\d{1,3}\s*[\.\):]\s*[A-D]\s*$/i;

export const PART_HEADER_RE = /\bPART\s*(\d)\b/i;

export const QUESTION_NUM_RE = /^\s*(?:Question\s+)?(\d{1,3})\s*[\.\)]\s*(.*)$/i;

export function extractOptionsFromBlock(block: string): string[] {
  const options: string[] = [];
  for (const line of block.split("\n")) {
    const m = line.match(OPTION_LINE_RE);
    if (m) options.push(m[2]!.trim());
  }
  return options;
}

export function splitByPartHeaders(text: string): Map<number, string> {
  const parts = new Map<number, string>();
  const re = /Part\s*(\d)\b/gi;
  const hits: { part: number; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    hits.push({ part: Number(m[1]), index: m.index });
  }
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i]!.index;
    const end = hits[i + 1]?.index ?? text.length;
    parts.set(hits[i]!.part, text.slice(start, end));
  }
  return parts;
}
