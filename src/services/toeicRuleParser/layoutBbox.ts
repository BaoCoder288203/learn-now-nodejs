import type { NormalizedBbox } from "../ai/types.js";
import type {
  PyMuPdfDocumentLayout,
  PyMuPdfImageRef,
  PyMuPdfPageLayout,
  PyMuPdfSpan,
} from "../pymupdfClient.js";
import {
  clusterSpansIntoLines,
  detectPageColumns,
  findPageForQuestion,
  findQuestionAnchors,
  type PageColumn,
} from "./columnLayout.js";

const MIN_BBOX_DIM = 0.02;
const MIN_GRAPHIC_AREA_RATIO = 0.03;
const QUESTION_TOP_MARGIN = 0.015;
const PAGE_TOP_MARGIN = 0.04;
// Graphic for a Part 3/4 group sits directly above its first question; never grab more
// than this fraction of page height above the question (avoids the whole upper page).
const MAX_GRAPHIC_HEIGHT = 0.34;
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

  const isOdd = questionNumber % 2 === 1;
  const partnerOnPage = isOdd ? questionNumber + 1 : questionNumber - 1;
  let partnerY: number | undefined;
  if (PART1_QUESTION_PAGES[partnerOnPage] === pageNum) {
    partnerY = findQuestionLabelY(page, `${partnerOnPage}.`);
  }

  const top = Math.max(0.04, yStart + 0.02);

  // Odd photo sits between its label and the next (even) label. The even photo has no
  // following label, so mirror the odd photo's height instead of running to page bottom
  // (which left a tall whitespace band below the even photos).
  let bottom: number;
  if (isOdd) {
    bottom = partnerY !== undefined ? partnerY - 0.01 : 0.92;
  } else if (partnerY !== undefined) {
    const oddPhotoHeight = yStart - 0.01 - (partnerY + 0.02);
    bottom = oddPhotoHeight > MIN_BBOX_DIM ? top + oddPhotoHeight : 0.92;
  } else {
    bottom = 0.92;
  }

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

function bboxArea(bbox: NormalizedBbox): number {
  return bbox[2] * bbox[3];
}

function imageCenterX(img: PyMuPdfImageRef): number {
  return img.bbox[0] + img.bbox[2] / 2;
}

function imageInColumn(
  img: PyMuPdfImageRef,
  column: PageColumn | "single",
  splitX: number,
  dualColumn: boolean
): boolean {
  if (!dualColumn || column === "single") return true;
  const cx = imageCenterX(img);
  return column === "left" ? cx < splitX : cx >= splitX;
}

// Graphics span their half of the page (divider ~ page center), which is wider than the
// question-number text column. Anchor-based splitX skews left, so use a fixed half-page
// divider for the graphic's horizontal extent.
const GRAPHIC_COLUMN_DIVIDER = 0.5;
const GRAPHIC_COLUMN_GUTTER = 0.015;

/** Horizontal extent [x, right] of a single (half-page) column band for graphics. */
function columnXRange(column: PageColumn): [number, number] {
  return column === "left"
    ? [0.05, GRAPHIC_COLUMN_DIVIDER - GRAPHIC_COLUMN_GUTTER]
    : [GRAPHIC_COLUMN_DIVIDER + GRAPHIC_COLUMN_GUTTER, 0.96];
}

/**
 * Bottom Y of the previous question/option text in the column, above the question gap.
 * Used to drop yTop just below the previous group so the crop only covers the graphic.
 */
function findColumnContentBottomAboveAnchor(
  page: PyMuPdfPageLayout,
  column: PageColumn,
  anchorY: number,
  midX: number,
  dualColumn: boolean
): number | undefined {
  const gapTop = anchorY - QUESTION_TOP_MARGIN;
  const lines = clusterSpansIntoLines(page.spans, 0.012, midX, dualColumn);
  let bottom: number | undefined;

  for (const line of lines) {
    const lineCol: PageColumn = line.x < midX ? "left" : "right";
    if (dualColumn && lineCol !== column) continue;

    const lineBottom = line.bbox[1] + line.bbox[3];
    if (lineBottom > gapTop) continue;

    const text = line.text.trim();
    const isPrevContent = /\([A-D]\)/.test(text) || /^\d{1,3}\s*\./.test(text);
    if (isPrevContent && (bottom === undefined || lineBottom > bottom)) {
      bottom = lineBottom;
    }
  }

  return bottom;
}

/** Single-column vertical strip just above the question, used as graphic fallback. */
function findListeningColumnStripBbox(
  column: PageColumn,
  yTop: number,
  yBottom: number
): NormalizedBbox | undefined {
  if (yBottom <= yTop + MIN_BBOX_DIM) return undefined;
  const [x, right] = columnXRange(column);
  const w = Math.max(MIN_BBOX_DIM, right - x);
  return clampBboxLoose([x, yTop, w, yBottom - yTop]);
}

/** Clamp a candidate bbox into the column band and the [yTop, yBottom] graphic window. */
function clampToColumnBand(
  bbox: NormalizedBbox | undefined,
  column: PageColumn,
  yTop: number,
  yBottom: number
): NormalizedBbox | undefined {
  if (!bbox) return undefined;
  const [colX, colRight] = columnXRange(column);
  const x = Math.max(colX, bbox[0]);
  const right = Math.min(colRight, bbox[0] + bbox[2]);
  const y = Math.max(yTop, bbox[1]);
  const bottom = Math.min(yBottom, bbox[1] + bbox[3]);
  return clampBboxLoose([x, y, right - x, bottom - y]);
}

function findListeningGraphicFromEmbeddedImages(
  page: PyMuPdfPageLayout,
  column: PageColumn | "single",
  yTop: number,
  yBottom: number,
  splitX: number,
  dualColumn: boolean
): NormalizedBbox | undefined {
  const candidates = page.images.filter((img) => {
    const [ix, iy, iw, ih] = img.bbox;
    const imgBottom = iy + ih;
    if (imgBottom > yBottom + 0.01 || iy < yTop - 0.01) return false;
    if (bboxArea(img.bbox) < MIN_GRAPHIC_AREA_RATIO) return false;
    return imageInColumn(img, column, splitX, dualColumn);
  });

  if (!candidates.length) return undefined;

  candidates.sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox));
  const best = candidates[0]!.bbox;
  return clampBboxLoose([
    Math.max(0.04, best[0] - 0.01),
    Math.max(0.03, best[1] - 0.01),
    Math.min(0.96, best[2] + 0.02),
    Math.min(0.92, best[3] + 0.02),
  ]);
}

/**
 * Locate the true position of a question-number label on the page. PyMuPDF often emits the
 * number ("68") and its dot+text (". Look at the graphic…") as separate spans, so the generic
 * anchor finder (which expects "68.") can mis-place it onto a duplicate phrase elsewhere
 * (e.g. another "Look at the graphic" question). For graphic cropping we need the exact
 * column/y, so match the bare number span directly.
 */
function findQuestionNumberSpanPos(
  page: PyMuPdfPageLayout,
  qNum: number
): { x: number; y: number } | undefined {
  const exactRe = new RegExp(`^${qNum}\\.?$`);
  const matches = page.spans.filter((s) => exactRe.test(s.text.trim()));
  if (!matches.length) return undefined;

  // Prefer a number span that begins a question line (a sibling span on the same row that
  // continues with a dot/option/question text), which disambiguates stray numbers.
  const scored = matches.map((s) => {
    const [x, y] = s.bbox;
    const sibling = page.spans.some((o) => {
      if (o === s) return false;
      if (Math.abs(o.bbox[1] - y) > 0.014) return false;
      if (o.bbox[0] <= x) return false;
      return /^\.|graphic|\([A-D]\)/i.test(o.text.trim());
    });
    return { x, y, score: sibling ? 1 : 0 };
  });
  scored.sort((a, b) => b.score - a.score || a.y - b.y);
  return { x: scored[0]!.x, y: scored[0]!.y };
}

/**
 * Bbox for Part 3/4 embedded chart/mockup above question anchors.
 * Uses page.images first, then text-span heuristic, then column raster strip.
 */
export function findListeningGraphicBbox(
  page: PyMuPdfPageLayout,
  startQ: number,
  endQ: number,
  prevGroupEndQ?: number
): NormalizedBbox | undefined {
  const anchors = findQuestionAnchors(page, startQ, endQ);
  const anchorFromFinder = anchors.find((a) => a.questionNumber === startQ);

  const { splitX, dualColumn } = detectPageColumns(page);
  const midX = dualColumn ? splitX : 0.5;

  // Trust the bare-number span position over the generic anchor (which can be mis-placed).
  const directPos = findQuestionNumberSpanPos(page, startQ);
  const anchor = directPos
    ? {
        x: directPos.x,
        y: directPos.y,
        column: (dualColumn
          ? directPos.x < midX
            ? "left"
            : "right"
          : "single") as PageColumn | "single",
      }
    : anchorFromFinder;
  if (!anchor) return undefined;

  const yBottom = anchor.y - QUESTION_TOP_MARGIN;

  // The graphic lives in the same column as its question; pick the side from the anchor x
  // even on pages we didn't classify as dual-column (a graphic only occupies one side).
  const column: PageColumn =
    anchor.column === "single" ? (anchor.x < midX ? "left" : "right") : anchor.column;
  const columnAware = dualColumn || anchor.column !== "single";

  // yTop: just below the previous question/option content in this column. Otherwise fall
  // back to a bounded band right above the question (never the entire upper page).
  let yTop = Math.max(PAGE_TOP_MARGIN, yBottom - MAX_GRAPHIC_HEIGHT);
  const contentBottom = findColumnContentBottomAboveAnchor(
    page,
    column,
    anchor.y,
    midX,
    columnAware
  );
  if (contentBottom !== undefined && contentBottom < yBottom) {
    yTop = Math.max(yTop, contentBottom + 0.008);
  } else if (prevGroupEndQ != null) {
    const prevAnchors = findQuestionAnchors(page, prevGroupEndQ, prevGroupEndQ);
    const prevAnchor = prevAnchors.find((a) => a.questionNumber === prevGroupEndQ);
    if (prevAnchor && prevAnchor.column === anchor.column) {
      yTop = Math.max(yTop, prevAnchor.y + 0.12);
    }
  }

  if (yBottom - yTop < MIN_BBOX_DIM) return undefined;

  const fromImages = findListeningGraphicFromEmbeddedImages(
    page,
    column,
    yTop,
    yBottom,
    GRAPHIC_COLUMN_DIVIDER,
    true
  );
  if (fromImages) {
    return clampToColumnBand(fromImages, column, yTop, yBottom) ?? fromImages;
  }

  const fromText = findListeningVisualBbox(page, startQ, endQ);
  const fromTextClamped = clampToColumnBand(fromText, column, yTop, yBottom);
  if (fromTextClamped) return fromTextClamped;

  return findListeningColumnStripBbox(column, yTop, yBottom);
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
  for (const page of layout.pages) {
    const anchors = findQuestionAnchors(page, questionNumber - 2, questionNumber + 2);
    if (anchors.some((a) => a.questionNumber === questionNumber)) return page;
  }

  return findPageForQuestion(layout, questionNumber);
}
