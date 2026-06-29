import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedBbox } from "../ai/types.js";
import type { PyMuPdfPageLayout } from "../pymupdfClient.js";
import { isListeningGraphicGroup } from "./patterns.js";
import { findListeningGraphicBbox } from "./layoutBbox.js";

function bbox(x: number, y: number, w: number, h: number): NormalizedBbox {
  return [x, y, w, h];
}

function makeListeningGraphicPage(images: PyMuPdfPageLayout["images"]): PyMuPdfPageLayout {
  return {
    pageNumber: 8,
    width: 612,
    height: 792,
    text: "65. 66. Look at the graphic. 68. 69. Look at the graphic.",
    spans: [
      { text: "65.", bbox: bbox(0.08, 0.42, 0.04, 0.02) },
      { text: "What does the woman say?", bbox: bbox(0.08, 0.44, 0.35, 0.02) },
      { text: "(A) option", bbox: bbox(0.08, 0.46, 0.12, 0.02) },
      { text: "66.", bbox: bbox(0.08, 0.5, 0.04, 0.02) },
      { text: "Look at the graphic.", bbox: bbox(0.08, 0.52, 0.35, 0.02) },
      { text: "(A) Location", bbox: bbox(0.08, 0.54, 0.12, 0.02) },
      { text: "67.", bbox: bbox(0.08, 0.58, 0.04, 0.02) },
      { text: "68.", bbox: bbox(0.55, 0.42, 0.04, 0.02) },
      { text: "What industry?", bbox: bbox(0.55, 0.44, 0.35, 0.02) },
      { text: "(A) Retail", bbox: bbox(0.55, 0.46, 0.12, 0.02) },
      { text: "69.", bbox: bbox(0.55, 0.5, 0.04, 0.02) },
      { text: "Look at the graphic.", bbox: bbox(0.55, 0.52, 0.35, 0.02) },
      { text: "70.", bbox: bbox(0.55, 0.58, 0.04, 0.02) },
    ],
    blocks: [],
    images,
  };
}

describe("isListeningGraphicGroup", () => {
  it("allows only last 3 P3 and last 2 P4 groups", () => {
    assert.equal(isListeningGraphicGroup(3, 62), true);
    assert.equal(isListeningGraphicGroup(3, 65), true);
    assert.equal(isListeningGraphicGroup(3, 68), true);
    assert.equal(isListeningGraphicGroup(3, 59), false);
    assert.equal(isListeningGraphicGroup(4, 95), true);
    assert.equal(isListeningGraphicGroup(4, 98), true);
    assert.equal(isListeningGraphicGroup(4, 92), false);
  });
});

describe("findListeningGraphicBbox", () => {
  const leftGraphic = { xref: 1, bbox: bbox(0.08, 0.12, 0.38, 0.2) };
  const rightGraphic = { xref: 2, bbox: bbox(0.52, 0.12, 0.38, 0.2) };

  it("picks left-column embedded image for Q65–67", () => {
    const page = makeListeningGraphicPage([leftGraphic, rightGraphic]);
    const result = findListeningGraphicBbox(page, 65, 67, 64);
    assert.ok(result);
    assert.ok(result![0] < 0.3, "graphic should be in left column");
    assert.ok(result![1] < 0.35, "graphic should be above questions");
  });

  it("picks right-column embedded image for Q68–70", () => {
    const page = makeListeningGraphicPage([leftGraphic, rightGraphic]);
    const result = findListeningGraphicBbox(page, 68, 70, 67);
    assert.ok(result);
    assert.ok(result![0] > 0.45, "graphic should be in right column");
  });

  it("falls back to column raster strip when page.images is empty and no text cues", () => {
    const page: PyMuPdfPageLayout = {
      ...makeListeningGraphicPage([]),
      spans: [
        { text: "65.", bbox: bbox(0.08, 0.42, 0.04, 0.02) },
        { text: "What does the woman say?", bbox: bbox(0.08, 0.44, 0.35, 0.02) },
        { text: "(A) option", bbox: bbox(0.08, 0.46, 0.12, 0.02) },
        { text: "66.", bbox: bbox(0.08, 0.5, 0.04, 0.02) },
        { text: "Which category?", bbox: bbox(0.08, 0.52, 0.35, 0.02) },
        { text: "67.", bbox: bbox(0.08, 0.58, 0.04, 0.02) },
      ],
      text: "65. 66. 67.",
    };
    const result = findListeningGraphicBbox(page, 65, 67, 64);
    assert.ok(result);
    assert.ok(result![0] < 0.3);
    assert.ok(result![3] > 0.1);
  });
});
