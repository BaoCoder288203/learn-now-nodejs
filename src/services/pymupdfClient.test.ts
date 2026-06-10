import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spansToTextRegions } from "./pymupdfClient.js";
import type { PyMuPdfSpan } from "./pymupdfClient.js";

describe("spansToTextRegions", () => {
  it("creates regions from word spans", () => {
    const spans: PyMuPdfSpan[] = [
      { text: "temporary", bbox: [0.1, 0.2, 0.05, 0.02] },
      { text: "office", bbox: [0.2, 0.2, 0.04, 0.02] },
    ];
    const regions = spansToTextRegions(spans);
    assert.equal(regions.length, 2);
    assert.equal(regions[0]!.text, "temporary");
  });
});
