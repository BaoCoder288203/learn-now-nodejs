import type { RcAnswerMap } from "../toeicAiService.js";
import type { PyMuPdfDocumentLayout } from "../pymupdfClient.js";
import type { RawToeicGroup, RawToeicQuestion } from "./types.js";
import { OPTION_LINE_RE, PART_RANGES } from "./patterns.js";
import {
  findListeningVisualBbox,
  findPageContainingQuestion,
  findPageForPassageHeader,
  findPassageBboxOnPage,
} from "./layoutBbox.js";

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

    const qDot = new RegExp(`(?:^|\\n)\\s*${header.startQ}\\.\\s*\\(A\\)`, "m");
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
  const startRe = new RegExp(`(?:^|\\n)\\s*${questionNumber}\\.\\s*`, "gi");
  let best: RawToeicQuestion | null = null;

  let startMatch: RegExpExecArray | null;
  while ((startMatch = startRe.exec(sectionText)) !== null) {
    const rest = sectionText.slice(startMatch.index);
    const headerLen = startMatch[0].length;
    const tail = rest.slice(headerLen);
    const nextQ = new RegExp(`(?:^|\\n)\\s*${questionNumber + 1}\\.\\s*`, "m");
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
      .replace(new RegExp(`^\\s*${questionNumber}\\.\\s*`, "i"), "")
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

export function buildReadingGroupsFromPassages(
  sectionText: string,
  layout: PyMuPdfDocumentLayout,
  passageBlocks: PassageBlock[],
  rcAnswers: RcAnswerMap,
  attachVisuals = false
): RawToeicGroup[] {
  const groups: RawToeicGroup[] = [];

  for (const block of passageBlocks) {
    const questions: RawToeicQuestion[] = [];
    for (let q = block.startQ; q <= block.endQ; q++) {
      const parsed = extractQuestionAtDot(sectionText, q, rcAnswers);
      if (parsed) questions.push(parsed);
    }
    if (!questions.length) continue;

    const page = findPageForPassageHeader(layout, block.startQ, block.endQ);
    const sourcePage = page?.pageNumber;
    const imageBbox = page ? findPassageBboxOnPage(page, block.startQ, block.endQ) : undefined;

    groups.push({
      passage: block.passage,
      sourcePage,
      imageBbox,
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
  return buildReadingGroupsFromPassages(section, layout, blocks, rcAnswers);
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
  const groups = buildReadingGroupsFromPassages(section, layout, blocks, rcAnswers);
  if (chunkStart == null || chunkEnd == null) return groups;

  return groups
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
  const range = PART_RANGES[partNumber]!;
  const sectionPages = layout.pages.filter((p) => {
    const t = p.text;
    return t.includes(`${range.start}.`) || t.includes(` ${range.start}.`);
  });

  return groups.map((group) => {
    const nums = group.questions.map((q) => q.questionNumber);
    const startQ = Math.min(...nums);
    const endQ = Math.max(...nums);

    let page = sectionPages.find((p) => new RegExp(`\\b${startQ}\\.`).test(p.text));
    if (!page) page = findPageContainingQuestion(layout, startQ);
    if (!page) return group;

    const visual = findListeningVisualBbox(page, startQ, endQ);
    if (!visual) return group;

    return {
      ...group,
      sourcePage: page.pageNumber,
      imageBbox: visual,
    };
  });
}
