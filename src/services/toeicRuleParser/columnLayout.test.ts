import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PyMuPdfPageLayout } from "../pymupdfClient.js";
import type { NormalizedBbox } from "../ai/types.js";
import {
  clusterSpansIntoLines,
  detectPageColumns,
  extractQuestionBlockFromPage,
  findQuestionAnchors,
  sortSpansReadingOrder,
} from "./columnLayout.js";

function bbox(x: number, y: number, w: number, h: number): NormalizedBbox {
  return [x, y, w, h];
}

function makePage(spans: PyMuPdfPageLayout["spans"]): PyMuPdfPageLayout {
  return {
    pageNumber: 1,
    width: 612,
    height: 792,
    text: spans.map((s) => s.text).join(" "),
    spans,
    blocks: [],
    images: [],
  };
}

describe("columnLayout two-column reading order", () => {
  it("detectPageColumns finds dual columns from anchor positions", () => {
    const page = makePage([
      { text: "101.", bbox: bbox(0.08, 0.2, 0.04, 0.02) },
      { text: "105.", bbox: bbox(0.55, 0.2, 0.04, 0.02) },
    ]);
    const info = detectPageColumns(page);
    assert.equal(info.dualColumn, true);
    // Split must sit in the gutter between columns, not through left-column body text.
    assert.ok(info.splitX >= 0.45);
  });

  it("extractQuestionBlockFromPage keeps wrapped left-column stem tails (Part 5)", () => {
    const page = makePage([
      { text: "101.", bbox: bbox(0.08, 0.2, 0.04, 0.02) },
      { text: "Using proper techniques", bbox: bbox(0.13, 0.2, 0.22, 0.02) },
      { text: "to ------- items", bbox: bbox(0.36, 0.2, 0.12, 0.02) },
      { text: "drastically reduces the risk of back injury.", bbox: bbox(0.13, 0.24, 0.38, 0.02) },
      { text: "(A) lift", bbox: bbox(0.13, 0.28, 0.12, 0.02) },
      { text: "(B) lifting", bbox: bbox(0.13, 0.31, 0.12, 0.02) },
      { text: "(C) lifted", bbox: bbox(0.13, 0.34, 0.12, 0.02) },
      { text: "(D) lifts", bbox: bbox(0.13, 0.37, 0.12, 0.02) },
      { text: "105.", bbox: bbox(0.55, 0.2, 0.04, 0.02) },
      { text: "Employees must submit forms", bbox: bbox(0.55, 0.22, 0.35, 0.02) },
      { text: "before Friday deadline.", bbox: bbox(0.55, 0.24, 0.35, 0.02) },
      { text: "(A) submit", bbox: bbox(0.55, 0.26, 0.15, 0.02) },
      { text: "(B) submits", bbox: bbox(0.55, 0.28, 0.15, 0.02) },
      { text: "(C) submitted", bbox: bbox(0.55, 0.3, 0.15, 0.02) },
      { text: "(D) submitting", bbox: bbox(0.55, 0.32, 0.15, 0.02) },
    ]);

    const q101 = extractQuestionBlockFromPage(page, 101, {}, 101, 130);
    assert.ok(q101);
    assert.match(q101!.questionText, /to ------- items/i);
    assert.match(q101!.questionText, /drastically reduces the risk of back injury/i);
    assert.match(q101!.questionText, /Using proper techniques/i);

    const q105 = extractQuestionBlockFromPage(page, 105, {}, 101, 130);
    assert.ok(q105);
    assert.match(q105!.questionText, /Employees must submit/i);
    assert.doesNotMatch(q105!.questionText, /------- items/i);
    assert.doesNotMatch(q105!.questionText, /proper techniques/i);
  });

  it("sortSpansReadingOrder reads left column before right column", () => {
    const spans = [
      { text: "right-top", bbox: bbox(0.55, 0.1, 0.2, 0.02) },
      { text: "left-top", bbox: bbox(0.08, 0.1, 0.2, 0.02) },
      { text: "left-bottom", bbox: bbox(0.08, 0.3, 0.2, 0.02) },
      { text: "right-bottom", bbox: bbox(0.55, 0.3, 0.2, 0.02) },
    ];
    const ordered = sortSpansReadingOrder(spans, 0.5, true);
    assert.deepEqual(
      ordered.map((s) => s.text),
      ["left-top", "left-bottom", "right-top", "right-bottom"]
    );
  });

  it("extractQuestionBlockFromPage: Q101 does not bleed into Q105 (right column)", () => {
    const page = makePage([
      { text: "101.", bbox: bbox(0.08, 0.2, 0.04, 0.02) },
      { text: "The regional manager announced", bbox: bbox(0.08, 0.22, 0.35, 0.02) },
      { text: "a new policy yesterday.", bbox: bbox(0.08, 0.24, 0.35, 0.02) },
      { text: "(A) policy", bbox: bbox(0.08, 0.26, 0.15, 0.02) },
      { text: "(B) policies", bbox: bbox(0.08, 0.28, 0.15, 0.02) },
      { text: "(C) politic", bbox: bbox(0.08, 0.3, 0.15, 0.02) },
      { text: "(D) political", bbox: bbox(0.08, 0.32, 0.15, 0.02) },
      { text: "102.", bbox: bbox(0.08, 0.4, 0.04, 0.02) },
      { text: "105.", bbox: bbox(0.55, 0.2, 0.04, 0.02) },
      { text: "Employees must submit forms", bbox: bbox(0.55, 0.22, 0.35, 0.02) },
      { text: "before Friday deadline.", bbox: bbox(0.55, 0.24, 0.35, 0.02) },
      { text: "(A) submit", bbox: bbox(0.55, 0.26, 0.15, 0.02) },
      { text: "(B) submits", bbox: bbox(0.55, 0.28, 0.15, 0.02) },
      { text: "(C) submitted", bbox: bbox(0.55, 0.3, 0.15, 0.02) },
      { text: "(D) submitting", bbox: bbox(0.55, 0.32, 0.15, 0.02) },
    ]);

    const anchors = findQuestionAnchors(page, 101, 105);
    assert.equal(anchors.length, 3);

    const q101 = extractQuestionBlockFromPage(page, 101, {}, 101, 130);
    assert.ok(q101);
    assert.doesNotMatch(q101!.questionText, /\b105\b/);
    assert.match(q101!.questionText, /regional manager/i);
    assert.equal(q101!.options.length, 4);

    const q105 = extractQuestionBlockFromPage(page, 105, {}, 101, 130);
    assert.ok(q105);
    assert.match(q105!.questionText, /Employees must submit/i);
    assert.doesNotMatch(q105!.questionText, /\b101\b/);
  });

  it("misaligned row: Q101 left + Q105 right at same Y stay in separate bands", () => {
    const sameY = 0.2;
    const page = makePage([
      { text: "101.", bbox: bbox(0.08, sameY, 0.04, 0.02) },
      { text: "Stem for one oh one only.", bbox: bbox(0.08, sameY + 0.02, 0.35, 0.02) },
      { text: "(A) one", bbox: bbox(0.08, sameY + 0.04, 0.12, 0.02) },
      { text: "(B) two", bbox: bbox(0.08, sameY + 0.06, 0.12, 0.02) },
      { text: "(C) three", bbox: bbox(0.08, sameY + 0.08, 0.12, 0.02) },
      { text: "(D) four", bbox: bbox(0.08, sameY + 0.1, 0.12, 0.02) },
      { text: "105.", bbox: bbox(0.55, sameY, 0.04, 0.02) },
      { text: "Stem for one oh five only.", bbox: bbox(0.55, sameY + 0.02, 0.35, 0.02) },
      { text: "(A) alpha", bbox: bbox(0.55, sameY + 0.04, 0.12, 0.02) },
      { text: "(B) beta", bbox: bbox(0.55, sameY + 0.06, 0.12, 0.02) },
      { text: "(C) gamma", bbox: bbox(0.55, sameY + 0.08, 0.12, 0.02) },
      { text: "(D) delta", bbox: bbox(0.55, sameY + 0.1, 0.12, 0.02) },
    ]);

    const q101 = extractQuestionBlockFromPage(page, 101, {}, 101, 130);
    const q105 = extractQuestionBlockFromPage(page, 105, {}, 101, 130);
    assert.ok(q101);
    assert.ok(q105);
    assert.match(q101!.questionText, /one oh one/i);
    assert.doesNotMatch(q101!.questionText, /\b105\b/);
    assert.match(q105!.questionText, /one oh five/i);
    assert.doesNotMatch(q105!.questionText, /\b101\b/);
  });

  it("findQuestionAnchors merges fragmented spans on same line", () => {
    const page = makePage([
      { text: "101", bbox: bbox(0.08, 0.2, 0.03, 0.02) },
      { text: ".", bbox: bbox(0.11, 0.2, 0.01, 0.02) },
      { text: "The manager said", bbox: bbox(0.13, 0.2, 0.2, 0.02) },
    ]);
    const lines = clusterSpansIntoLines(page.spans);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!.text, /^101\s*\./);

    const anchors = findQuestionAnchors(page, 101, 130);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]!.questionNumber, 101);
  });

  it("joins split question-number glyph spans so the anchor is detected (Part 5)", () => {
    // PyMuPDF splits "112." into adjacent spans "11" + "2." with no gap.
    const page = makePage([
      { text: "11", bbox: bbox(0.0875, 0.2, 0.0159, 0.02) },
      { text: "2.", bbox: bbox(0.1034, 0.2, 0.0223, 0.02) },
      { text: "Adalet Farm's unique method has proved effective.", bbox: bbox(0.132, 0.2, 0.33, 0.02) },
      { text: "(A) far", bbox: bbox(0.132, 0.24, 0.12, 0.02) },
      { text: "(B) correctly", bbox: bbox(0.132, 0.27, 0.12, 0.02) },
      { text: "(C) highly", bbox: bbox(0.132, 0.3, 0.12, 0.02) },
      { text: "(D) much", bbox: bbox(0.132, 0.33, 0.12, 0.02) },
    ]);

    const lines = clusterSpansIntoLines(page.spans);
    assert.match(lines[0]!.text, /^112\.\s/);

    const anchors = findQuestionAnchors(page, 101, 130);
    assert.ok(anchors.some((a) => a.questionNumber === 112), "Q112 anchor must be found");

    const q112 = extractQuestionBlockFromPage(page, 112, {}, 101, 130);
    assert.ok(q112, "Q112 must be parsed");
    assert.match(q112!.questionText, /^Adalet Farm/);
    assert.doesNotMatch(q112!.questionText, /11 2|^112/);
    assert.equal(q112!.options.length, 4);
  });

  it("joins tightly split word spans without inserting a false space", () => {
    const page = makePage([
      { text: "32.", bbox: bbox(0.08, 0.2, 0.04, 0.02) },
      { text: "Which parking area", bbox: bbox(0.13, 0.2, 0.2, 0.02) },
      { text: "w", bbox: bbox(0.335, 0.2, 0.006, 0.02) },
      { text: "ill", bbox: bbox(0.342, 0.2, 0.015, 0.02) },
      { text: "be closed?", bbox: bbox(0.37, 0.2, 0.12, 0.02) },
      { text: "(A) Area A", bbox: bbox(0.13, 0.24, 0.12, 0.02) },
      { text: "(B) Area B", bbox: bbox(0.13, 0.27, 0.12, 0.02) },
      { text: "(C) Area C", bbox: bbox(0.13, 0.3, 0.12, 0.02) },
      { text: "(D) Area D", bbox: bbox(0.13, 0.33, 0.12, 0.02) },
    ]);

    const q32 = extractQuestionBlockFromPage(page, 32, {}, 32, 70);
    assert.ok(q32);
    assert.match(q32!.questionText, /area will be closed/i);
    assert.doesNotMatch(q32!.questionText, /w ill/i);
  });

  it("excludes graphic text inside bbox from listening question text", () => {
    const page = makePage([
      { text: "32.", bbox: bbox(0.08, 0.2, 0.04, 0.02) },
      { text: "Look at the graphic. Which parking area will be closed?", bbox: bbox(0.13, 0.2, 0.45, 0.02) },
      { text: "PARKING AREA A", bbox: bbox(0.18, 0.25, 0.2, 0.02) },
      { text: "PARKING AREA B", bbox: bbox(0.18, 0.28, 0.2, 0.02) },
      { text: "(A) Area A", bbox: bbox(0.13, 0.36, 0.12, 0.02) },
      { text: "(B) Area B", bbox: bbox(0.13, 0.39, 0.12, 0.02) },
      { text: "(C) Area C", bbox: bbox(0.13, 0.42, 0.12, 0.02) },
      { text: "(D) Area D", bbox: bbox(0.13, 0.45, 0.12, 0.02) },
    ]);

    const q32 = extractQuestionBlockFromPage(page, 32, {}, 32, 70, bbox(0.16, 0.24, 0.25, 0.08));
    assert.ok(q32);
    assert.match(q32!.questionText, /Which parking area will be closed/i);
    assert.doesNotMatch(q32!.questionText, /PARKING AREA A/i);
  });
});
