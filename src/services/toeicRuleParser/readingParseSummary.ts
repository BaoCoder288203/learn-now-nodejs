import { PART_RANGES } from "./patterns.js";
import type { RawToeicPart } from "./types.js";

function formatMissingRanges(nums: number[]): string {
  if (!nums.length) return "—";

  const ranges: string[] = [];
  let runStart = nums[0]!;
  let prev = nums[0]!;

  const flush = (start: number, end: number) => {
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  };

  for (let i = 1; i < nums.length; i++) {
    const q = nums[i]!;
    if (q === prev + 1) {
      prev = q;
      continue;
    }
    flush(runStart, prev);
    runStart = q;
    prev = q;
  }
  flush(runStart, prev);
  return ranges.join(", ");
}

/** Summarize P5–P7 parse counts and missing question numbers. */
export function summarizeReadingParse(parts: RawToeicPart[]): string[] {
  const lines: string[] = [];
  let total = 0;

  for (const partNum of [5, 6, 7] as const) {
    const part = parts.find((p) => p.partNumber === partNum);
    const range = PART_RANGES[partNum]!;
    const expected = range.end - range.start + 1;
    const parsed = new Set(
      part?.groups.flatMap((g) => g.questions.map((q) => q.questionNumber)) ?? []
    );
    const missing: number[] = [];
    for (let q = range.start; q <= range.end; q++) {
      if (!parsed.has(q)) missing.push(q);
    }
    total += parsed.size;
    lines.push(
      `[TOEIC parse] Part ${partNum}: ${parsed.size}/${expected} | missing: ${formatMissingRanges(missing)}`
    );
  }

  lines.push(`[TOEIC parse] Reading total: ${total}/100`);
  return lines;
}
