import type { NormalizedBbox } from "../ai/types.js";
import type { PyMuPdfDocumentLayout, PyMuPdfPageLayout, PyMuPdfSpan } from "../pymupdfClient.js";

const MIN_BBOX_DIM = 0.02;
const PART1_QUESTION_PAGES: Record<number, number> = {
  1: 2,
  2: 2,
  3: 3,
  4: 3,
  5: 4,
  6: 4,
};

export function unionBbox(boxes: NormalizedBbox[]): NormalizedBbox | undefined {
  if (!boxes.length) return undefined;
  const x = Math.min(...boxes.map((b) => b[0]));
  const y = Math.min(...boxes.map((b) => b[1]));
  const x2 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y2 = Math.max(...boxes.map((b) => b[1] + b[3]));
  const w = x2 - x;
  const h = y2 - y;
  if (w < MIN_BBOX_DIM || h < MIN_BBOX_DIM) return undefined;
  return [x, y, w, h];
}

export function clampBboxLoose(bbox: NormalizedBbox): NormalizedBbox | undefined {
  let [x, y, w, h] = bbox;
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return undefined;
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  w = Math.max(0, Math.min(1 - x, w));
  h = Math.max(0, Math.min(1 - y, h));
  if (w < MIN_BBOX_DIM || h < MIN_BBOX_DIM) return undefined;
  return [x, y, w, h];
}

function findQuestionLabelY(page: PyMuPdfPageLayout, label: string): number | undefined {
  const re = new RegExp(`^${label.replace(".", "\\.")}$`);
  for (const block of page.blocks) {
    const t = block.text.trim();
    if (re.test(t)) return block.bbox[1];
  }
  for (const span of page.spans) {
    if (re.test(span.text.trim())) return span.bbox[1];
  }
  return undefined;
}

/** Crop photo area for Part 1 using question number labels on exam pages. */
export function findPart1PhotoBbox(
  layout: PyMuPdfDocumentLayout,
  questionNumber: number
): { sourcePage: number; imageBbox: NormalizedBbox } | undefined {
  const pageNum = PART1_QUESTION_PAGES[questionNumber];
  if (!pageNum) return undefined;

  const page = layout.pages.find((p) => p.pageNumber === pageNum);
  if (!page) return undefined;

  const label = `${questionNumber}.`;
  const yStart = findQuestionLabelY(page, label);
  if (yStart === undefined) return undefined;

  const partnerOnPage = questionNumber % 2 === 1 ? questionNumber + 1 : questionNumber - 1;
  let yEnd: number | undefined;
  if (PART1_QUESTION_PAGES[partnerOnPage] === pageNum) {
    yEnd = findQuestionLabelY(page, `${partnerOnPage}.`);
  }
  if (yEnd === undefined) yEnd = 0.92;

  const top = Math.max(0.04, yStart + 0.02);
  const bottom = questionNumber % 2 === 1 ? yEnd - 0.01 : 0.92;
  const h = bottom - top;
  if (h < MIN_BBOX_DIM) return undefined;

  const bbox = clampBboxLoose([0.08, top, 0.84, h]);
  if (!bbox) return undefined;
  return { sourcePage: pageNum, imageBbox: bbox };
}

function isEnglishPassageSpan(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 2) return false;
  const letters = (t.match(/[a-zA-Z]/g) ?? []).length;
  return letters >= t.length * 0.4;
}

/** Bbox for passage block between header and first question options on a page. */
export function findPassageBboxOnPage(
  page: PyMuPdfPageLayout,
  startQ: number,
  endQ: number
): NormalizedBbox | undefined {
  const headerRe = new RegExp(`Questions?\\s+${startQ}\\s*-\\s*${endQ}`, "i");
  const questionStartRe = new RegExp(`${startQ}\\.\\s*\\(A\\)`, "i");

  let headerBottom: number | null = null;
  let questionTop: number | null = null;
  const passageSpans: PyMuPdfSpan[] = [];

  for (const span of page.spans) {
    const t = span.text.trim();
    if (headerRe.test(t)) {
      headerBottom = span.bbox[1] + span.bbox[3];
      continue;
    }
    if (headerBottom !== null && questionStartRe.test(t)) {
      questionTop = span.bbox[1];
      break;
    }
    if (headerBottom !== null && questionTop === null && isEnglishPassageSpan(t)) {
      if (span.bbox[1] >= headerBottom - 0.01) {
        passageSpans.push(span);
      }
    }
  }

  const fromSpans = unionBbox(passageSpans.map((s) => s.bbox));
  if (fromSpans) {
    return clampBboxLoose([
      Math.max(0.06, fromSpans[0] - 0.01),
      Math.max(0, fromSpans[1] - 0.005),
      Math.min(0.92, fromSpans[2] + 0.02),
      Math.min(0.95 - fromSpans[1], fromSpans[3] + 0.015),
    ]);
  }

  if (headerBottom !== null && questionTop !== null && questionTop > headerBottom) {
    return clampBboxLoose([0.08, headerBottom + 0.005, 0.84, questionTop - headerBottom - 0.01]);
  }

  return undefined;
}

function findQuestionAnchorY(page: PyMuPdfPageLayout, questionNumber: number): number | undefined {
  const re = new RegExp(`^${questionNumber}\\.`);
  for (const span of page.spans) {
    if (re.test(span.text.trim())) return span.bbox[1];
  }
  return undefined;
}

/** Detect table/graphic bbox (right column or "Look at the graphic") for Part 3/4. */
export function findListeningVisualBbox(
  page: PyMuPdfPageLayout,
  startQ: number,
  endQ: number
): NormalizedBbox | undefined {
  const yStart = findQuestionAnchorY(page, startQ);
  const yEndAnchor = findQuestionAnchorY(page, endQ + 1) ?? findQuestionAnchorY(page, endQ);
  if (yStart === undefined) return undefined;

  const yMax = yEndAnchor !== undefined ? yEndAnchor + 0.15 : yStart + 0.35;
  const visualSpans: PyMuPdfSpan[] = [];

  for (const span of page.spans) {
    const t = span.text.trim();
    const [x, y, , h] = span.bbox;
    if (y + h < yStart - 0.05 || y > yMax) continue;

    const hasGraphicCue = /graphic|chart|table|schedule|notice|e-mail|email|form/i.test(t);
    const hasMoney = /\$[\d,]+/.test(t) && x > 0.45;
    const isRightColumnTable = x > 0.5 && /\$|Cost|Company/i.test(t);

    if (hasGraphicCue || hasMoney || isRightColumnTable) {
      visualSpans.push(span);
    }
  }

  if (!visualSpans.length) return undefined;

  const bbox = unionBbox(visualSpans.map((s) => s.bbox));
  if (!bbox) return undefined;
  return clampBboxLoose([
    Math.max(0.05, bbox[0] - 0.02),
    Math.max(0.04, bbox[1] - 0.02),
    Math.min(0.95, bbox[2] + 0.04),
    Math.min(0.9, bbox[3] + 0.04),
  ]);
}

export function findPageForPassageHeader(
  layout: PyMuPdfDocumentLayout,
  startQ: number,
  endQ: number
): PyMuPdfPageLayout | undefined {
  const headerRe = new RegExp(`Questions?\\s+${startQ}\\s*-\\s*${endQ}`, "i");
  for (const page of layout.pages) {
    if (headerRe.test(page.text)) return page;
  }
  return undefined;
}

export function findPageContainingQuestion(
  layout: PyMuPdfDocumentLayout,
  questionNumber: number
): PyMuPdfPageLayout | undefined {
  const re = new RegExp(`\\b${questionNumber}\\.`);
  for (const page of layout.pages) {
    if (re.test(page.text)) return page;
  }
  return undefined;
}
