import type { RcAnswerMap } from "../toeicAiService.js";
import type { PyMuPdfDocumentLayout } from "../pymupdfClient.js";
import type { RawToeicGroup, RawToeicPart, RawToeicQuestion } from "./types.js";
import { PART_RANGES } from "./patterns.js";
import { findPart1PhotoBbox } from "./layoutBbox.js";
import {
  buildPart6Groups,
  buildPart7Groups,
  extractPartSection,
  extractQuestionAtDot,
} from "./passageExtract.js";

function extractPart5Questions(
  examText: string,
  rcAnswers: RcAnswerMap
): RawToeicQuestion[] {
  const range = PART_RANGES[5]!;
  const section = extractPartSection(examText, 5);
  const questions: RawToeicQuestion[] = [];
  for (let q = range.start; q <= range.end; q++) {
    const parsed = extractQuestionAtDot(section, q, rcAnswers);
    if (parsed) questions.push(parsed);
  }
  return questions;
}

export function parseReadingPart5(
  examText: string,
  _layout: PyMuPdfDocumentLayout,
  rcAnswers: RcAnswerMap
): RawToeicPart {
  const questions = extractPart5Questions(examText, rcAnswers);
  return {
    partNumber: 5,
    groups: questions.map((q) => ({ questions: [q] })),
  };
}

export function parseReadingPart6(
  examText: string,
  layout: PyMuPdfDocumentLayout,
  rcAnswers: RcAnswerMap
): RawToeicPart {
  return { partNumber: 6, groups: buildPart6Groups(examText, layout, rcAnswers) };
}

export function parseReadingPart7Chunk(
  examText: string,
  layout: PyMuPdfDocumentLayout,
  rcAnswers: RcAnswerMap,
  chunkStart: number,
  chunkEnd: number
): RawToeicPart {
  return {
    partNumber: 7,
    groups: buildPart7Groups(examText, layout, rcAnswers, chunkStart, chunkEnd),
  };
}

export function attachPart1Images(
  part1: RawToeicPart,
  layout: PyMuPdfDocumentLayout
): RawToeicPart {
  const groups = part1.groups.map((g) => {
    const q = g.questions[0];
    if (!q) return g;
    const loc = findPart1PhotoBbox(layout, q.questionNumber);
    if (!loc) return g;
    return {
      ...g,
      sourcePage: loc.sourcePage,
      imageBbox: loc.imageBbox,
    };
  });

  return { ...part1, groups };
}
