import type { RcAnswerMap } from "../toeicAiService.js";
import type { PyMuPdfDocumentLayout } from "../pymupdfClient.js";
import type { RawToeicGroup, RawToeicPart, RawToeicQuestion } from "./types.js";
import { PART_RANGES } from "./patterns.js";
import { findPart1PhotoBbox } from "./layoutBbox.js";
import { buildPart6Groups, buildPart7Groups } from "./passageExtract.js";
import {
  FULL_PAGE_BBOX,
  extractQuestionBlockFromPage,
  extractQuestionFromLayout,
  findPageForQuestion,
  findQuestionAnchors,
  pagesForQuestionRange,
} from "./columnLayout.js";

function mergeQuestionIntoGroups(
  groups: RawToeicGroup[],
  pageNumber: number,
  question: RawToeicQuestion
): RawToeicGroup[] {
  const existing = groups.find((g) => g.sourcePage === pageNumber);
  if (existing) {
    if (!existing.questions.some((q) => q.questionNumber === question.questionNumber)) {
      existing.questions.push(question);
      existing.questions.sort((a, b) => a.questionNumber - b.questionNumber);
    }
    return groups;
  }
  return [
    ...groups,
    {
      sourcePage: pageNumber,
      imageBbox: FULL_PAGE_BBOX,
      questions: [question],
    },
  ];
}

function extractPart5QuestionsFromLayout(
  layout: PyMuPdfDocumentLayout,
  rcAnswers: RcAnswerMap
): { groups: RawToeicGroup[]; parsedNums: Set<number> } {
  const range = PART_RANGES[5]!;
  const pages = pagesForQuestionRange(layout, range.start, range.end);
  let groups: RawToeicGroup[] = [];
  const parsedNums = new Set<number>();

  for (const page of pages) {
    const anchors = findQuestionAnchors(page, range.start, range.end);
    const questions: RawToeicQuestion[] = [];
    for (const anchor of anchors) {
      const parsed = extractQuestionBlockFromPage(
        page,
        anchor.questionNumber,
        rcAnswers,
        range.start,
        range.end
      );
      if (parsed) {
        questions.push(parsed);
        parsedNums.add(parsed.questionNumber);
      }
    }
    if (!questions.length) continue;
    questions.sort((a, b) => a.questionNumber - b.questionNumber);
    groups.push({
      sourcePage: page.pageNumber,
      imageBbox: FULL_PAGE_BBOX,
      questions,
    });
  }

  for (let q = range.start; q <= range.end; q++) {
    if (parsedNums.has(q)) continue;
    const parsed = extractQuestionFromLayout(layout, q, rcAnswers, range.start, range.end);
    if (!parsed) continue;
    parsedNums.add(q);
    const page = findPageForQuestion(layout, q, range.start, range.end);
    if (page) {
      groups = mergeQuestionIntoGroups(groups, page.pageNumber, parsed);
    }
  }

  groups = groups.filter((g) => g.sourcePage && g.sourcePage > 0);
  groups.sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0));
  return { groups, parsedNums };
}

export function parseReadingPart5(
  _examText: string,
  layout: PyMuPdfDocumentLayout,
  rcAnswers: RcAnswerMap
): RawToeicPart {
  const { groups } = extractPart5QuestionsFromLayout(layout, rcAnswers);
  if (!groups.length) {
    console.warn("[TOEIC parse] Part 5: layout parser returned 0 groups");
  }
  return { partNumber: 5, groups };
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
