import type { RcAnswerMap } from "../toeicAiService.js";
import type { PyMuPdfDocumentLayout } from "../pymupdfClient.js";
import type { RawToeicGroup, RawToeicQuestion } from "./types.js";
import { OPTION_LINE_RE, GRAPHIC_QUESTION_CUE_RE, isListeningGraphicGroup, PART_RANGES } from "./patterns.js";
import {
  findListeningGraphicBbox,
  findListeningVisualBbox,
  findPageContainingQuestion,
  findPageForPassageHeader,
} from "./layoutBbox.js";
import {
  FULL_PAGE_BBOX,
  extractQuestionFromLayout,
  findPageForQuestion,
} from "./columnLayout.js";

const PASSAGE_HEADER_RE =
  /Question\s*s?\s+(\d{1,3})\s*-\s*(\d{1,3})\s+refer\s+to\s+the\s+following/gi;

const QUESTION_DOT_RE = /(?:^|\n)\s*(\d{1,3})\.\s*\(A\)\s*/g;

function findSectionBounds(
  examText: string,
  startPatterns: RegExp[],
  endPattern: RegExp
): string {
  let startIdx = -1;
  for (const re of startPatterns) {
    const m = re.exec(examText);
    if (m) {
      startIdx = m.index;
      break;
    }
  }
  if (startIdx < 0) return examText;

  const afterStart = examText.slice(startIdx);
  const endMatch = endPattern.exec(afterStart.slice(8));
  if (endMatch && endMatch.index >= 0) {
    return afterStart.slice(0, endMatch.index + 8);
  }
  return afterStart;
}

export function extractPartSection(examText: string, partNumber: number): string {
  if (partNumber === 5) {
    return findSectionBounds(
      examText,
      [/\bPARTS\b/i, /(?:^|\n)\s*101\.\s/],
      /\bPART\s*6\b/i
    );
  }
  if (partNumber === 6) {
    return findSectionBounds(examText, [/\bPART\s*6\b/i], /\bPART\s*7\b/i);
  }
  if (partNumber === 7) {
    const m = /\bPART\s*7\b/i.exec(examText);
    return m ? examText.slice(m.index) : examText;
  }

  const startRe = new RegExp(`\\bPART\\s*${partNumber}\\b`, "i");
  const startMatch = startRe.exec(examText);
  if (!startMatch) return examText;

  const afterStart = examText.slice(startMatch.index);
  const nextRe = new RegExp(`\\bPART\\s*${partNumber + 1}\\b`, "i");
  const nextMatch = nextRe.exec(afterStart.slice(8));
  if (nextMatch && nextMatch.index >= 0) {
    return afterStart.slice(0, nextMatch.index + 8);
  }
  return afterStart;
}

export interface PassageBlock {
  startQ: number;
  endQ: number;
  passage: string;
}

export function extractPassageBlocks(sectionText: string): PassageBlock[] {
  const blocks: PassageBlock[] = [];
  const headers: { startQ: number; endQ: number; index: number; length: number }[] = [];

  let m: RegExpExecArray | null;
  const re = new RegExp(PASSAGE_HEADER_RE.source, "gi");
  while ((m = re.exec(sectionText)) !== null) {
    headers.push({
      startQ: Number(m[1]),
      endQ: Number(m[2]),
      index: m.index,
      length: m[0].length,
    });
  }

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!;
    const sliceStart = header.index + header.length;
    const sliceEnd = headers[i + 1]?.index ?? sectionText.length;
    const slice = sectionText.slice(sliceStart, sliceEnd);

    const qDot = new RegExp(`(?:^|\\n)\\s*${header.startQ}\\s*\\.\\s+`, "m");
    const qMatch = qDot.exec(slice);
    const passageRaw = qMatch ? slice.slice(0, qMatch.index) : slice;

    const passage = passageRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^GO ON TO THE NEXT PAGE/i.test(l) && !/^TEST\s+\d/i.test(l))
      .join("\n")
      .trim();

    if (passage.length > 20) {
      blocks.push({ startQ: header.startQ, endQ: header.endQ, passage });
    }
  }

  return blocks;
}

function parseOptionsFromLines(lines: string[]): string[] {
  const options: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const om = trimmed.match(OPTION_LINE_RE);
    const paren = trimmed.match(/^\(([A-D])\)\s*(.+)$/i);
    if (om) options.push(om[2]!.trim());
    else if (paren) options.push(paren[2]!.trim());
  }
  return options;
}

export function extractQuestionAtDot(
  sectionText: string,
  questionNumber: number,
  rcAnswers: RcAnswerMap
): RawToeicQuestion | null {
  const startRe = new RegExp(`(?:^|\\n)\\s*${questionNumber}\\s*\\.\\s*`, "gi");
  let best: RawToeicQuestion | null = null;

  let startMatch: RegExpExecArray | null;
  while ((startMatch = startRe.exec(sectionText)) !== null) {
    const rest = sectionText.slice(startMatch.index);
    const headerLen = startMatch[0].length;
    const tail = rest.slice(headerLen);
    const nextQ = new RegExp(`(?:^|\\n)\\s*${questionNumber + 1}\\s*\\.\\s*`, "m");
    let nextBoundary = tail.search(nextQ);
    if (nextBoundary < 0) {
      nextBoundary = tail.search(/(?:^|\n)\s*\d{1,3}\.\s+/m);
    }
    const block =
      nextBoundary >= 0 ? rest.slice(0, headerLen + nextBoundary) : rest.slice(0, 2000);

    const optionStart = block.search(/\(A\)\s*/i);
    if (optionStart < 0) continue;

    const questionText = block
      .slice(0, optionStart)
      .replace(new RegExp(`^\\s*${questionNumber}\\s*\\.\\s*`, "i"), "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^\([A-D]\)/.test(l))
      .join(" ")
      .trim();

    const options = parseOptionsFromLines(block.slice(optionStart).split("\n"));
    if (options.length < 2) continue;

    while (options.length < 4) options.push("-");

    const candidate: RawToeicQuestion = {
      questionNumber,
      questionText: questionText || `Question ${questionNumber}`,
      options: options.slice(0, 4),
      correctAnswer: rcAnswers[String(questionNumber)],
    };

    if (!best || candidate.options.filter((o) => o !== "-").length > best.options.filter((o) => o !== "-").length) {
      best = candidate;
    }
  }

  return best;
}

function extractQuestionForReading(
  layout: PyMuPdfDocumentLayout,
  questionNumber: number,
  rcAnswers: RcAnswerMap,
  partNumber: 5 | 6 | 7
): RawToeicQuestion | null {
  const range = PART_RANGES[partNumber]!;
  return extractQuestionFromLayout(
    layout,
    questionNumber,
    rcAnswers,
    range.start,
    range.end
  );
}

function fillMissingReadingQuestions(
  groups: RawToeicGroup[],
  sectionText: string,
  layout: PyMuPdfDocumentLayout,
  rcAnswers: RcAnswerMap,
  partNumber: 6 | 7,
  rangeStart: number,
  rangeEnd: number
): RawToeicGroup[] {
  const parsed = new Set(groups.flatMap((g) => g.questions.map((q) => q.questionNumber)));
  const missing: number[] = [];
  for (let q = rangeStart; q <= rangeEnd; q++) {
    if (!parsed.has(q)) missing.push(q);
  }
  if (!missing.length) return groups;

  const result = [...groups];
  let runStart = missing[0]!;
  let prev = missing[0]!;

  const flushRun = (start: number, end: number) => {
    const questions: RawToeicQuestion[] = [];
    for (let q = start; q <= end; q++) {
      const parsedQ = extractQuestionForReading(layout, q, rcAnswers, partNumber);
      if (parsedQ) questions.push(parsedQ);
    }
    if (!questions.length) return;
    const page = findPageForQuestion(layout, start, rangeStart, rangeEnd);
    result.push({
      sourcePage: page?.pageNumber,
      imageBbox: FULL_PAGE_BBOX,
      questions,
    });
  };

  for (let i = 1; i < missing.length; i++) {
    const q = missing[i]!;
    if (q === prev + 1) {
      prev = q;
      continue;
    }
    flushRun(runStart, prev);
    runStart = q;
    prev = q;
  }
  flushRun(runStart, prev);

  return result;
}

function pageRangeBetween(start?: number, end?: number): number[] | undefined {
  if (!start && !end) return undefined;
  if (!start) return end ? [end] : undefined;
  if (!end) return [start];

  const first = Math.min(start, end);
  const last = Math.max(start, end);
  const pages: number[] = [];
  for (let page = first; page <= last; page++) pages.push(page);
  return pages;
}

export function buildReadingGroupsFromPassages(
  sectionText: string,
  layout: PyMuPdfDocumentLayout,
  passageBlocks: PassageBlock[],
  rcAnswers: RcAnswerMap,
  attachVisuals = false,
  partNumber: 6 | 7 = 6
): RawToeicGroup[] {
  const groups: RawToeicGroup[] = [];

  for (const block of passageBlocks) {
    const questions: RawToeicQuestion[] = [];
    for (let q = block.startQ; q <= block.endQ; q++) {
      const parsed = extractQuestionForReading(layout, q, rcAnswers, partNumber);
      if (parsed) questions.push(parsed);
    }
    if (!questions.length) continue;

    const page = findPageForPassageHeader(layout, block.startQ, block.endQ);
    const sourcePage = page?.pageNumber ?? findPageForQuestion(layout, block.startQ)?.pageNumber;
    const lastQuestionPage = findPageForQuestion(layout, block.endQ)?.pageNumber;

    groups.push({
      passage: block.passage,
      sourcePage,
      sourcePages: pageRangeBetween(sourcePage, lastQuestionPage),
      imageBbox: FULL_PAGE_BBOX,
      questions,
    });
  }

  if (attachVisuals) {
    for (const group of groups) {
      if (group.imageBbox) continue;
      const firstQ = group.questions[0]?.questionNumber;
      const lastQ = group.questions[group.questions.length - 1]?.questionNumber;
      if (!firstQ || !lastQ) continue;
      const page = findPageContainingQuestion(layout, firstQ);
      if (!page) continue;
      const visual = findListeningVisualBbox(page, firstQ, lastQ);
      if (visual) {
        group.sourcePage = page.pageNumber;
        group.imageBbox = visual;
      }
    }
  }

  return groups;
}

export function buildPart6Groups(
  examText: string,
  layout: PyMuPdfDocumentLayout,
  rcAnswers: RcAnswerMap
): RawToeicGroup[] {
  const section = extractPartSection(examText, 6);
  const blocks = extractPassageBlocks(section);
  return buildReadingGroupsFromPassages(section, layout, blocks, rcAnswers, false, 6);
}

export function buildPart7Groups(
  examText: string,
  layout: PyMuPdfDocumentLayout,
  rcAnswers: RcAnswerMap,
  chunkStart?: number,
  chunkEnd?: number
): RawToeicGroup[] {
  const section = extractPartSection(examText, 7);
  let blocks = extractPassageBlocks(section);
  if (chunkStart != null && chunkEnd != null) {
    blocks = blocks.filter((b) => b.endQ >= chunkStart && b.startQ <= chunkEnd);
  }
  const groups = buildReadingGroupsFromPassages(section, layout, blocks, rcAnswers, false, 7);
  const rangeStart = chunkStart ?? PART_RANGES[7]!.start;
  const rangeEnd = chunkEnd ?? PART_RANGES[7]!.end;
  const filled = fillMissingReadingQuestions(
    groups,
    section,
    layout,
    rcAnswers,
    7,
    rangeStart,
    rangeEnd
  );
  if (chunkStart == null || chunkEnd == null) return filled;

  return filled
    .map((group) => ({
      ...group,
      questions: group.questions.filter(
        (q) => q.questionNumber >= chunkStart && q.questionNumber <= chunkEnd
      ),
    }))
    .filter((group) => group.questions.length > 0);
}

/** Part 3/4: attach graphic bbox from exam PDF when group needs visual context. */
export function attachListeningGroupVisuals(
  groups: RawToeicGroup[],
  layout: PyMuPdfDocumentLayout,
  partNumber: 3 | 4
): RawToeicGroup[] {
  return groups.map((group) => {
    const nums = group.questions.map((q) => q.questionNumber);
    if (!nums.length) return group;

    const startQ = Math.min(...nums);
    const endQ = Math.max(...nums);

    if (!isListeningGraphicGroup(partNumber, startQ)) {
      return group;
    }

    const hasGraphicCue = group.questions.some((q) =>
      GRAPHIC_QUESTION_CUE_RE.test(q.questionText)
    );
    if (!hasGraphicCue) {
      console.warn(
        `[TOEIC parse] Part ${partNumber} group Q${startQ}–${endQ}: no graphic cue in question text; attempting bbox anyway.`
      );
    }

    const page = findPageContainingQuestion(layout, startQ);
    if (!page) return group;

    const prevGroupEndQ = startQ - 1;
    const visual = findListeningGraphicBbox(page, startQ, endQ, prevGroupEndQ);
    if (!visual) return group;

    return {
      ...group,
      sourcePage: page.pageNumber,
      imageBbox: visual,
    };
  });
}

// Characters that never appear in clean TOEIC question/option text — a reliable garble signal.
const GARBLE_NEVER_RE = /[~^_=<>{}\\|¬`]/;
// Two adjacent non-alphanumeric, non-space chars (e.g. ":;:", "~~") indicate OCR/font garble.
const GARBLE_SYMBOL_RUN_RE = /[^A-Za-z0-9\s]{2}/;
// PDF text layers sometimes split one word into spans, e.g. "w ill" for "will".
const SPLIT_WORD_RE = /\b(?:w\s+ill|w\s+ould|w\s+as|w\s+ere|c\s+an|c\s+ould|s\s+hould|t\s+he|t\s+hey|t\s+hat|f\s+or|b\s+e)\b/i;

/** Detect text mangled by KEY-LC font/encoding issues (e.g. ":;:r~~.ii!.", "£&71Af"). */
function isGarbledText(text: string | undefined): boolean {
  const s = (text ?? "").trim();
  if (!s || s === "-") return false;
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  if (s.length >= 3 && letters === 0) return true;
  if (GARBLE_NEVER_RE.test(s)) return true;
  if (GARBLE_SYMBOL_RUN_RE.test(s) && letters < s.length * 0.6) return true;
  if (SPLIT_WORD_RE.test(s)) return true;
  return false;
}

/**
 * Part 3/4 question text + options come from the KEY LC PDF, whose text layer is sometimes
 * garbled on a few lines (and can drop/shift options). When a question looks garbled, re-extract
 * its text and options from the cleaner exam-booklet layout. The answer-key letter is preserved
 * because the exam booklet defines the canonical A/B/C/D order the key refers to.
 */
export function repairListeningQuestionsFromLayout(
  groups: RawToeicGroup[],
  layout: PyMuPdfDocumentLayout,
  partNumber: 3 | 4
): RawToeicGroup[] {
  const range = PART_RANGES[partNumber]!;
  return groups.map((group) => {
    const nums = group.questions.map((q) => q.questionNumber);
    const startQ = nums.length ? Math.min(...nums) : null;
    const endQ = nums.length ? Math.max(...nums) : null;
    let graphicBbox = group.imageBbox;

    if (!graphicBbox && startQ != null && endQ != null && isListeningGraphicGroup(partNumber, startQ)) {
      const page = findPageContainingQuestion(layout, startQ);
      if (page) {
        graphicBbox = findListeningGraphicBbox(page, startQ, endQ, startQ - 1);
      }
    }

    return {
      ...group,
      questions: group.questions.map((q) => {
        const qGarbled = isGarbledText(q.questionText);
        const optGarbled = q.options.some((o) => isGarbledText(o));
        if (!qGarbled && !optGarbled) return q;

        const fixed = extractQuestionFromLayout(
          layout,
          q.questionNumber,
          {},
          range.start,
          range.end,
          graphicBbox
        );
        if (!fixed) return q;

        const fixedOptsClean = fixed.options.filter((o) => o && o !== "-" && !isGarbledText(o));
        const nextText =
          qGarbled && fixed.questionText && !isGarbledText(fixed.questionText)
            ? fixed.questionText
            : q.questionText;
        const nextOptions = optGarbled && fixedOptsClean.length >= 3 ? fixed.options : q.options;

        if (nextText === q.questionText && nextOptions === q.options) return q;
        console.warn(
          `[TOEIC parse] Part ${partNumber} Q${q.questionNumber}: repaired garbled text/options from exam layout.`
        );
        return { ...q, questionText: nextText, options: nextOptions };
      }),
    };
  });
}
