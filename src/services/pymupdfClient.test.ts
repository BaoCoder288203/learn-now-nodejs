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

  it("splits multi-word span bbox per word instead of sharing full line bbox", () => {
    const spans: PyMuPdfSpan[] = [
      { text: "The regional manager", bbox: [0.1, 0.2, 0.4, 0.02] },
    ];
    const regions = spansToTextRegions(spans);
    assert.equal(regions.length, 3);
    assert.deepEqual(
      regions.map((r) => r.text),
      ["The", "regional", "manager"]
    );
    assert.ok(regions[0]!.bbox[2] < 0.4, "first word width should be smaller than span");
    assert.ok(regions[1]!.bbox[0] > regions[0]!.bbox[0], "second word should start further right");
    assert.notDeepEqual(regions[0]!.bbox, regions[1]!.bbox);
  });
});
