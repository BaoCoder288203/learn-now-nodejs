import type { NormalizedBbox } from "../ai/types.js";
import type { PyMuPdfDocumentLayout, PyMuPdfPageLayout, PyMuPdfSpan } from "../pymupdfClient.js";
import type { RcAnswerMap } from "../toeicAiService.js";
import type { RawToeicQuestion } from "./types.js";
import { OPTION_LINE_RE } from "./patterns.js";

export const FULL_PAGE_BBOX: NormalizedBbox = [0, 0, 1, 1];

const Y_LINE_TOLERANCE = 0.012;
const COLUMN_X_TOLERANCE = 0.05;

export function isFullPageBbox(bbox: NormalizedBbox): boolean {
  const [x, y, w, h] = bbox;
  return x <= 0.01 && y <= 0.01 && w >= 0.99 && h >= 0.99;
}

export type PageColumn = "left" | "right";

export interface QuestionAnchor {
  questionNumber: number;
  column: PageColumn | "single";
  bbox: NormalizedBbox;
  y: number;
  x: number;
}

export interface PageColumnInfo {
  splitX: number;
  dualColumn: boolean;
}

export interface SpanLine {
  text: string;
  y: number;
  x: number;
  bbox: NormalizedBbox;
  spans: PyMuPdfSpan[];
}

const QUESTION_LABEL_ONLY_RE = /^(\d{1,3})\s*\.$/;
const QUESTION_LABEL_INLINE_RE = /^(\d{1,3})\s*\.\s+/;

function spanColumn(span: PyMuPdfSpan, splitX: number, dualColumn: boolean): PageColumn | "single" {
  if (!dualColumn) return "single";
  return span.bbox[0] < splitX ? "left" : "right";
}

function unionLineBbox(spans: PyMuPdfSpan[]): NormalizedBbox {
  const xs = spans.map((s) => s.bbox[0]);
  const ys = spans.map((s) => s.bbox[1]);
  const x2 = spans.map((s) => s.bbox[0] + s.bbox[2]);
  const y2 = spans.map((s) => s.bbox[1] + s.bbox[3]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return [x, y, Math.max(...x2) - x, Math.max(...y2) - y];
}

function isSingleAlphaToken(text: string): boolean {
  return /^[A-Za-z]$/.test(text.trim());
}

function joinLineSpans(spans: PyMuPdfSpan[]): string {
  if (!spans.length) return "";
  const sorted = [...spans].sort((a, b) => a.bbox[0] - b.bbox[0]);
  let text = sorted[0]!.text.trim();

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const current = sorted[i]!;
    const prevText = prev.text.trim();
    const currentText = current.text.trim();
    if (!currentText) continue;

    const prevEnd = prev.bbox[0] + prev.bbox[2];
    const gap = current.bbox[0] - prevEnd;
    const tight = gap <= 0.004;
    // PyMuPDF often splits a number into adjacent glyph spans with no gap
    // (e.g. "11" + "2." => "112.", "1" + "0" => "10"). Joining with a space
    // breaks question-number anchors and pollutes stem text, so fuse tight
    // digit boundaries without a space.
    const joinTightDigits = tight && /\d$/.test(prevText) && /^\d/.test(currentText);
    const shouldJoinWithoutSpace =
      (tight && (isSingleAlphaToken(prevText) || isSingleAlphaToken(currentText))) ||
      joinTightDigits;

    if (shouldJoinWithoutSpace || /^[,.;:!?)]/.test(currentText) || /[(]$/.test(text)) {
      text += currentText;
    } else {
      text += ` ${currentText}`;
    }
  }

  return text.replace(/\s+/g, " ").trim();
}

/** Group spans into horizontal lines by Y proximity (within the same column when dual-column). */
export function clusterSpansIntoLines(
  spans: PyMuPdfSpan[],
  yTolerance = Y_LINE_TOLERANCE,
  splitX = 0.5,
  dualColumn = false
): SpanLine[] {
  if (!spans.length) return [];

  const spanGroups = dualColumn
    ? [
        spans.filter((s) => spanColumn(s, splitX, dualColumn) !== "right"),
        spans.filter((s) => spanColumn(s, splitX, dualColumn) === "right"),
      ]
    : [spans];

  const lines: SpanLine[] = [];

  for (const group of spanGroups) {
    if (!group.length) continue;
    const sorted = [...group].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
    let current: PyMuPdfSpan[] = [sorted[0]!];
    let lineY = sorted[0]!.bbox[1];

    for (let i = 1; i < sorted.length; i++) {
      const span = sorted[i]!;
      if (Math.abs(span.bbox[1] - lineY) <= yTolerance) {
        current.push(span);
      } else {
        current.sort((a, b) => a.bbox[0] - b.bbox[0]);
        lines.push({
          text: joinLineSpans(current),
          y: lineY,
          x: current[0]!.bbox[0],
          bbox: unionLineBbox(current),
          spans: current,
        });
        current = [span];
        lineY = span.bbox[1];
      }
    }

    current.sort((a, b) => a.bbox[0] - b.bbox[0]);
    lines.push({
      text: joinLineSpans(current),
      y: lineY,
      x: current[0]!.bbox[0],
      bbox: unionLineBbox(current),
      spans: current,
    });
  }

  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  return lines;
}

/** Build ordered line strings from spans (for option parsing). */
export function linesFromSpans(
  spans: PyMuPdfSpan[],
  splitX = 0.5,
  dualColumn = false
): string[] {
  return clusterSpansIntoLines(spans, Y_LINE_TOLERANCE, splitX, dualColumn)
    .map((line) => line.text)
    .filter(Boolean);
}

function parseQuestionNumberFromText(text: string): number | null {
  const t = text.trim();
  const only = t.match(QUESTION_LABEL_ONLY_RE);
  if (only) return Number(only[1]);
  const inline = t.match(QUESTION_LABEL_INLINE_RE);
  if (inline) return Number(inline[1]);
  return null;
}

function median(values: number[]): number {
  if (!values.length) return 0.5;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Detect left/right column split from question-number anchor positions. */
export function detectPageColumns(page: PyMuPdfPageLayout): PageColumnInfo {
  const anchorXs: number[] = [];
  for (const span of page.spans) {
    if (parseQuestionNumberFromText(span.text) != null) {
      anchorXs.push(span.bbox[0]);
    }
  }

  if (anchorXs.length < 2) {
    return { splitX: 0.5, dualColumn: false };
  }

  const leftCount = anchorXs.filter((x) => x < 0.5).length;
  const rightCount = anchorXs.filter((x) => x >= 0.5).length;
  const dualColumn = leftCount >= 1 && rightCount >= 1;

  if (!dualColumn) {
    return { splitX: 0.5, dualColumn: false };
  }

  const rightXs = anchorXs.filter((x) => x >= 0.5);
  // Place split just left of the right column's question labels. Using the
  // midpoint of left/right anchor X positions (~0.30) cuts through left-column
  // body text (which extends to ~0.45) and drops wrapped line tails.
  const splitX =
    rightXs.length > 0 ? Math.max(0.45, Math.min(...rightXs) - 0.02) : 0.5;

  return { splitX, dualColumn: true };
}

export function sortSpansReadingOrder(
  spans: PyMuPdfSpan[],
  splitX: number,
  dualColumn: boolean
): PyMuPdfSpan[] {
  if (!dualColumn) {
    return [...spans].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  }

  const left: PyMuPdfSpan[] = [];
  const right: PyMuPdfSpan[] = [];
  for (const span of spans) {
    const col = spanColumn(span, splitX, dualColumn);
    if (col === "right") right.push(span);
    else left.push(span);
  }

  const byPos = (a: PyMuPdfSpan, b: PyMuPdfSpan) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0];
  left.sort(byPos);
  right.sort(byPos);
  return [...left, ...right];
}

function filterAnchorsByColumnCluster(
  anchors: QuestionAnchor[],
  dualColumn: boolean
): QuestionAnchor[] {
  if (!dualColumn || anchors.length < 2) return anchors;

  const leftXs = anchors.filter((a) => a.column === "left").map((a) => a.x);
  const rightXs = anchors.filter((a) => a.column === "right").map((a) => a.x);
  const leftMedian = leftXs.length ? median(leftXs) : null;
  const rightMedian = rightXs.length ? median(rightXs) : null;

  return anchors.filter((a) => {
    if (a.column === "single") return true;
    if (a.column === "left" && leftMedian != null && leftXs.length >= 2) {
      return Math.abs(a.x - leftMedian) <= COLUMN_X_TOLERANCE;
    }
    if (a.column === "right" && rightMedian != null && rightXs.length >= 2) {
      return Math.abs(a.x - rightMedian) <= COLUMN_X_TOLERANCE;
    }
    return true;
  });
}

function anchorOptionsScore(
  page: PyMuPdfPageLayout,
  anchor: QuestionAnchor,
  splitX: number,
  dualColumn: boolean
): number {
  let score = 0;
  const labelOnly = page.spans.some(
    (s) =>
      s.bbox[0] === anchor.x &&
      Math.abs(s.bbox[1] - anchor.y) < 0.01 &&
      /^\d{1,3}\s*\.$/.test(s.text.trim())
  );
  if (labelOnly) score += 2;

  const colLines = clusterSpansIntoLines(page.spans, Y_LINE_TOLERANCE, splitX, dualColumn).filter(
    (line) =>
      dualColumn && anchor.column !== "single"
        ? (line.x < splitX ? "left" : "right") === anchor.column
        : true
  );
  const hasOptions = colLines.some(
    (line) =>
      line.y >= anchor.y - 0.01 &&
      line.y <= anchor.y + 0.08 &&
      /\(A\)/i.test(line.text)
  );
  if (hasOptions) score += 4;

  return score + anchor.y;
}

function augmentAnchorsFromPageText(
  page: PyMuPdfPageLayout,
  anchors: QuestionAnchor[],
  qStart: number,
  qEnd: number,
  splitX: number,
  dualColumn: boolean,
  upsertAnchor: (qNum: number, bbox: NormalizedBbox, y: number, x: number) => void
): void {
  const have = new Set(anchors.map((a) => a.questionNumber));
  for (let qNum = qStart; qNum <= qEnd; qNum++) {
    if (have.has(qNum)) continue;
    const re = new RegExp(`\\b${qNum}\\.\\s*([^\\n]{4,120})`);
    const m = re.exec(page.text);
    if (!m) continue;

    const stemHint = m[1]!.replace(/-+/g, " ").trim().slice(0, 30);
    const words = stemHint.split(/\s+/).slice(0, 3).join(" ");
    if (words.length < 4) continue;

    const span = page.spans.find((s) => s.text.includes(words));
    if (!span) continue;

    upsertAnchor(qNum, span.bbox, span.bbox[1], span.bbox[0]);
    have.add(qNum);
  }
}

/** Find question-number anchors on a page within [qStart, qEnd]. */
export function findQuestionAnchors(
  page: PyMuPdfPageLayout,
  qStart: number,
  qEnd: number
): QuestionAnchor[] {
  const { splitX, dualColumn } = detectPageColumns(page);
  const anchors: QuestionAnchor[] = [];

  const upsertAnchor = (qNum: number, bbox: NormalizedBbox, y: number, x: number) => {
    if (qNum < qStart || qNum > qEnd) return;
    const col: PageColumn | "single" = dualColumn ? (x < splitX ? "left" : "right") : "single";
    const candidate: QuestionAnchor = {
      questionNumber: qNum,
      column: col,
      bbox,
      y,
      x,
    };
    const existingIdx = anchors.findIndex((a) => a.questionNumber === qNum);
    if (existingIdx >= 0) {
      const existing = anchors[existingIdx]!;
      if (
        anchorOptionsScore(page, candidate, splitX, dualColumn) >
        anchorOptionsScore(page, existing, splitX, dualColumn)
      ) {
        anchors[existingIdx] = candidate;
      }
      return;
    }
    anchors.push(candidate);
  };

  for (const span of page.spans) {
    const qNum = parseQuestionNumberFromText(span.text.trim());
    if (qNum == null) continue;
    upsertAnchor(qNum, span.bbox, span.bbox[1], span.bbox[0]);
  }

  const lines = clusterSpansIntoLines(page.spans, Y_LINE_TOLERANCE, splitX, dualColumn);
  const inlineLabelRe = /(?:^|\s)(\d{1,3})\s*\./g;
  for (const line of lines) {
    const startQ = parseQuestionNumberFromText(line.text);
    if (startQ != null) upsertAnchor(startQ, line.bbox, line.y, line.x);

    let m: RegExpExecArray | null;
    inlineLabelRe.lastIndex = 0;
    while ((m = inlineLabelRe.exec(line.text)) !== null) {
      const qNum = Number(m[1]);
      if (qNum < 100) continue;
      upsertAnchor(qNum, line.bbox, line.y, line.x);
    }
  }

  augmentAnchorsFromPageText(page, anchors, qStart, qEnd, splitX, dualColumn, upsertAnchor);

  const filtered = filterAnchorsByColumnCluster(anchors, dualColumn);

  filtered.sort((a, b) => {
    if (a.column !== b.column) {
      if (a.column === "left" || a.column === "single") return -1;
      if (b.column === "left" || b.column === "single") return 1;
    }
    return a.y - b.y || a.x - b.x;
  });

  return filtered;
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

function spansInColumnBand(
  page: PyMuPdfPageLayout,
  column: PageColumn | "single",
  yStart: number,
  yEnd: number,
  splitX: number,
  dualColumn: boolean,
  excludeBbox?: NormalizedBbox
): PyMuPdfSpan[] {
  return page.spans.filter((span) => {
    const col = spanColumn(span, splitX, dualColumn);
    if (dualColumn && column !== "single" && col !== column) return false;
    const [x, y, w, h] = span.bbox;
    if (excludeBbox) {
      const [ex, ey, ew, eh] = excludeBbox;
      const spanCenterX = x + w / 2;
      const spanCenterY = y + h / 2;
      if (
        spanCenterX >= ex - 0.004 &&
        spanCenterX <= ex + ew + 0.004 &&
        spanCenterY >= ey - 0.004 &&
        spanCenterY <= ey + eh + 0.004
      ) {
        return false;
      }
    }
    const spanMid = y + h / 2;
    return spanMid >= yStart - 0.008 && spanMid < yEnd + 0.008;
  });
}

function isValidQuestion(parsed: RawToeicQuestion | null): parsed is RawToeicQuestion {
  return parsed != null && parsed.options.filter((o) => o !== "-").length >= 2;
}

function extractInlineStemFromPage(
  page: PyMuPdfPageLayout,
  questionNumber: number,
  beforeY: number,
  splitX: number,
  dualColumn: boolean
): string {
  const stemRe = new RegExp(`\\b${questionNumber}\\s*\\.\\s*(.+)`);
  const lines = clusterSpansIntoLines(page.spans, Y_LINE_TOLERANCE, splitX, dualColumn);
  for (const line of lines) {
    if (line.y >= beforeY) continue;
    const m = line.text.match(stemRe);
    if (m) {
      return m[1]!.replace(/-+/g, " ").replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

/** Extract one question block from layout spans (same column, anchor to next anchor). */
export function extractQuestionBlockFromPage(
  page: PyMuPdfPageLayout,
  questionNumber: number,
  rcAnswers: RcAnswerMap,
  qStart?: number,
  qEnd?: number,
  excludeBbox?: NormalizedBbox
): RawToeicQuestion | null {
  const rangeStart = qStart ?? 1;
  const rangeEnd = qEnd ?? 999;
  const { splitX, dualColumn } = detectPageColumns(page);
  const anchors = findQuestionAnchors(page, rangeStart, rangeEnd);
  const idx = anchors.findIndex((a) => a.questionNumber === questionNumber);
  if (idx < 0) return null;

  const anchor = anchors[idx]!;
  const sameCol = anchors.filter((a) => a.column === anchor.column);
  const colIdx = sameCol.findIndex((a) => a.questionNumber === questionNumber);
  const nextInCol = colIdx >= 0 ? sameCol[colIdx + 1] : undefined;
  const yStart = anchor.y;
  const yEnd = nextInCol?.y ?? 1;

  const bandSpans = sortSpansReadingOrder(
    spansInColumnBand(page, anchor.column, yStart, yEnd, splitX, dualColumn, excludeBbox),
    splitX,
    dualColumn
  );
  const lines = linesFromSpans(bandSpans, splitX, dualColumn);
  if (!lines.length) return null;

  const optionLineIdx = lines.findIndex((line) => /\(A\)/i.test(line));
  if (optionLineIdx < 0) return null;

  let questionText = lines
    .slice(0, optionLineIdx)
    .join(" ")
    .replace(new RegExp(`^\\s*${questionNumber}\\s*\\.\\s*`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();

  if (!questionText || questionText.length < 8) {
    const inlineStem = extractInlineStemFromPage(
      page,
      questionNumber,
      anchor.y,
      splitX,
      dualColumn
    );
    if (inlineStem) questionText = inlineStem;
  }

  const optionLines = lines.slice(optionLineIdx).map((line, i) =>
    i === 0 ? line.replace(new RegExp(`^\\s*${questionNumber}\\s*\\.\\s*`, "i"), "").trim() : line
  );
  const options = parseOptionsFromLines(optionLines);
  if (options.length < 2) return null;

  while (options.length < 4) options.push("-");

  return {
    questionNumber,
    questionText: questionText || `Question ${questionNumber}`,
    options: options.slice(0, 4),
    correctAnswer: rcAnswers[String(questionNumber)],
  };
}

/** Search all pages in range for a question via layout spans only. */
export function extractQuestionFromLayout(
  layout: PyMuPdfDocumentLayout,
  questionNumber: number,
  rcAnswers: RcAnswerMap,
  qStart: number,
  qEnd: number,
  excludeBbox?: NormalizedBbox
): RawToeicQuestion | null {
  const pagesInRange = pagesForQuestionRange(layout, qStart, qEnd);
  for (const page of pagesInRange) {
    const parsed = extractQuestionBlockFromPage(page, questionNumber, rcAnswers, qStart, qEnd, excludeBbox);
    if (isValidQuestion(parsed)) return parsed;
  }

  for (const page of layout.pages) {
    if (pagesInRange.includes(page)) continue;
    const parsed = extractQuestionBlockFromPage(page, questionNumber, rcAnswers, qStart, qEnd, excludeBbox);
    if (isValidQuestion(parsed)) return parsed;
  }

  return null;
}

/** Find the page that contains a question anchor. */
export function findPageForQuestion(
  layout: PyMuPdfDocumentLayout,
  questionNumber: number,
  qStart?: number,
  qEnd?: number
): PyMuPdfPageLayout | undefined {
  const start = qStart ?? Math.max(1, questionNumber - 2);
  const end = qEnd ?? Math.min(200, questionNumber + 2);

  for (const page of layout.pages) {
    const anchors = findQuestionAnchors(page, start, end);
    if (anchors.some((a) => a.questionNumber === questionNumber)) return page;
  }

  const re = new RegExp(`\\b${questionNumber}\\s*\\.`);
  for (const page of layout.pages) {
    if (re.test(page.text)) return page;
  }

  return undefined;
}

/** Pages that contain at least one question anchor in range. */
export function pagesForQuestionRange(
  layout: PyMuPdfDocumentLayout,
  qStart: number,
  qEnd: number
): PyMuPdfPageLayout[] {
  return layout.pages.filter(
    (page) => findQuestionAnchors(page, qStart, qEnd).length > 0
  );
}

/** Pages belonging to a reading part (by PART header or question anchors). */
export function pagesForReadingPart(
  layout: PyMuPdfDocumentLayout,
  partNumber: number
): PyMuPdfPageLayout[] {
  const partHeaderRe = new RegExp(`\\bPART\\s*${partNumber}\\b`, "i");
  const nextPartRe =
    partNumber < 7 ? new RegExp(`\\bPART\\s*${partNumber + 1}\\b`, "i") : null;

  let inPart = false;
  const pages: PyMuPdfPageLayout[] = [];
  for (const page of layout.pages) {
    if (partHeaderRe.test(page.text)) inPart = true;
    if (inPart) {
      pages.push(page);
      if (nextPartRe && nextPartRe.test(page.text) && pages.length > 1) {
        pages.pop();
        break;
      }
    }
  }

  if (pages.length) return pages;

  const rangeStart = partNumber === 5 ? 101 : partNumber === 6 ? 131 : 147;
  const rangeEnd = partNumber === 5 ? 130 : partNumber === 6 ? 146 : 200;
  return pagesForQuestionRange(layout, rangeStart, rangeEnd);
}

/** Build column-ordered plain text from layout pages (for passage header regex). */
export function buildLayoutSectionText(
  layout: PyMuPdfDocumentLayout,
  partNumber: number,
  chunkStart?: number,
  chunkEnd?: number
): string {
  const pages = pagesForReadingPart(layout, partNumber);
  const parts: string[] = [];

  for (const page of pages) {
    const { splitX, dualColumn } = detectPageColumns(page);
    const ordered = sortSpansReadingOrder(page.spans, splitX, dualColumn);
    parts.push(ordered.map((s) => s.text).join(" "));
  }

  let text = parts.join("\n\n");
  if (chunkStart != null && chunkEnd != null) {
    const headerRe = new RegExp(
      `Questions?\\s+(${chunkStart})\\s*-\\s*(${chunkEnd})\\s+refer`,
      "i"
    );
    const m = headerRe.exec(text);
    if (m) text = text.slice(m.index);
  }

  return text;
}
