import type { RcAnswerMap } from "../toeicAiService.js";
import { parseKeyRcFromText } from "./keyRc.js";
import {
  attachPart1Images,
  parseReadingPart5,
  parseReadingPart6,
  parseReadingPart7Chunk,
} from "./reading.js";
import { parseListeningParts } from "./listening.js";
import {
  attachListeningGroupVisuals,
  repairListeningQuestionsFromLayout,
} from "./passageExtract.js";
import type { RawToeicDocument, RawToeicPart, ToeicParserInput } from "./types.js";

export type { RawToeicDocument, RawToeicPart, ToeicParserInput, PyMuPdfExtractResult } from "./types.js";
export { parseKeyRcFromText } from "./keyRc.js";
export {
  attachPart1Images,
  parseReadingPart5,
  parseReadingPart6,
  parseReadingPart7Chunk,
} from "./reading.js";
export { parseListeningParts } from "./listening.js";
export {
  attachListeningGroupVisuals,
  repairListeningQuestionsFromLayout,
} from "./passageExtract.js";

export const PART7_CHUNK_RANGES = [
  { start: 147, end: 153 },
  { start: 154, end: 160 },
  { start: 161, end: 167 },
  { start: 168, end: 173 },
  { start: 174, end: 180 },
  { start: 181, end: 187 },
  { start: 188, end: 194 },
  { start: 195, end: 200 },
] as const;

export const PART7_NORMALIZE_CHUNK_STEP_IDS = [
  "gemini_normalize_7_chunk_0",
  "gemini_normalize_7_chunk_1",
  "gemini_normalize_7_chunk_2",
  "gemini_normalize_7_chunk_3",
  "gemini_normalize_7_chunk_4",
  "gemini_normalize_7_chunk_5",
  "gemini_normalize_7_chunk_6",
  "gemini_normalize_7_chunk_7",
] as const;

/** Slice a raw part to questions within [start, end] (for normalize/parse chunks). */
export function sliceRawPartByQuestionRange(
  raw: RawToeicPart,
  start: number,
  end: number
): RawToeicPart {
  const groups = raw.groups
    .map((g) => ({
      ...g,
      questions: g.questions.filter(
        (q) => q.questionNumber >= start && q.questionNumber <= end
      ),
    }))
    .filter((g) => g.questions.length > 0);
  return { partNumber: raw.partNumber, groups };
}

export function parseToeicDocument(input: ToeicParserInput): RawToeicDocument {
  const listening = parseListeningParts(input.keyLcText, input.examText);
  const part1 = attachPart1Images(
    listening.find((p) => p.partNumber === 1)!,
    input.examLayout
  );
  const parts: RawToeicPart[] = listening.map((p) => {
    if (p.partNumber === 1) return part1;
    if (p.partNumber === 3 || p.partNumber === 4) {
      const repaired = repairListeningQuestionsFromLayout(
        p.groups,
        input.examLayout,
        p.partNumber
      );
      return {
        ...p,
        groups: attachListeningGroupVisuals(repaired, input.examLayout, p.partNumber),
      };
    }
    return p;
  });
  parts.push(parseReadingPart5(input.examText, input.examLayout, input.rcAnswers));
  parts.push(parseReadingPart6(input.examText, input.examLayout, input.rcAnswers));

  const part7 = parseReadingPart7Chunk(
    input.examText,
    input.examLayout,
    input.rcAnswers,
    147,
    200
  );
  parts.push({ partNumber: 7, groups: part7.groups });

  return { parts: parts.sort((a, b) => a.partNumber - b.partNumber) };
}

export function parseRcKeyFromTextOrEmpty(text: string, fallback: RcAnswerMap = {}): RcAnswerMap {
  const parsed = parseKeyRcFromText(text);
  return Object.keys(parsed).length >= 50 ? parsed : { ...fallback, ...parsed };
}

export function countRawQuestions(doc: RawToeicDocument): number {
  return doc.parts.reduce(
    (sum, p) => sum + p.groups.reduce((gs, g) => gs + g.questions.length, 0),
    0
  );
}
