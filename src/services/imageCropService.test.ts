import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampBbox,
  filterRegionsInsideBbox,
  remapRegionsToCrop,
  regionIntersectsBbox,
} from "./imageCropBbox.js";
import type { TextRegion } from "./ai/types.js";

describe("imageCropService", () => {
  it("clampBbox rejects tiny boxes", () => {
    assert.equal(clampBbox([0, 0, 0.01, 0.5]), null);
    assert.deepEqual(clampBbox([0.1, 0.2, 0.3, 0.4]), [0.1, 0.2, 0.3, 0.4]);
  });

  it("regionIntersectsBbox uses overlap ratio", () => {
    const crop: [number, number, number, number] = [0.2, 0.2, 0.5, 0.5];
    assert.equal(regionIntersectsBbox([0.25, 0.25, 0.1, 0.1], crop), true);
    assert.equal(regionIntersectsBbox([0, 0, 0.05, 0.05], crop), false);
  });

  it("filterRegionsInsideBbox keeps overlapping regions", () => {
    const crop: [number, number, number, number] = [0, 0.3, 1, 0.4];
    const regions: TextRegion[] = [
      { id: "r1", text: "in", bbox: [0.1, 0.35, 0.05, 0.02] },
      { id: "r2", text: "out", bbox: [0.1, 0.05, 0.05, 0.02] },
    ];
    const filtered = filterRegionsInsideBbox(regions, crop);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.id, "r1");
  });

  it("remapRegionsToCrop shifts coordinates into crop space", () => {
    const crop: [number, number, number, number] = [0.2, 0.2, 0.5, 0.5];
    const regions: TextRegion[] = [
      { id: "r1", text: "word", bbox: [0.3, 0.3, 0.1, 0.05] },
    ];
    const remapped = remapRegionsToCrop(regions, crop);
    assert.equal(remapped.length, 1);
    assert.ok(Math.abs(remapped[0]!.bbox[0] - 0.2) < 0.001);
    assert.ok(Math.abs(remapped[0]!.bbox[1] - 0.2) < 0.001);
  });
});
