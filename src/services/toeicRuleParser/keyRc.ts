import type { RcAnswerMap } from "../toeicAiService.js";

/** Parse Reading answer key 101-200 from plain text (rule-based). */
export function parseKeyRcFromText(text: string): RcAnswerMap {
  const out: RcAnswerMap = {};
  const patterns = [
    /\b(1[0-9]{2}|200)\s*[\.\):\-]\s*([A-Da-d])\b/g,
    /\b(1[0-9]{2}|200)\s+([A-Da-d])\b/g,
    /(?:^|\s)(1[0-9]{2}|200)\s*[\(\[]?([A-Da-d])[\)\]]?/gm,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const num = Number(m[1]);
      if (num >= 101 && num <= 200) {
        out[String(num)] = m[2]!.toUpperCase();
      }
    }
  }

  return out;
}
