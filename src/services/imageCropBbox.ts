import type { NormalizedBbox, TextRegion } from "./ai/types.js";

const MIN_BBOX_DIM = 0.02;
const REGION_OVERLAP_MIN = 0.3;

export function clampBbox(bbox: NormalizedBbox): NormalizedBbox | null {
  let [x, y, w, h] = bbox;
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  w = Math.max(0, Math.min(1 - x, w));
  h = Math.max(0, Math.min(1 - y, h));
  if (w < MIN_BBOX_DIM || h < MIN_BBOX_DIM) return null;
  return [x, y, w, h];
}

function intersectionArea(a: NormalizedBbox, b: NormalizedBbox): number {
  const ax2 = a[0] + a[2];
  const ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2];
  const by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  return ix * iy;
}

function regionArea(bbox: NormalizedBbox): number {
  return bbox[2] * bbox[3];
}

export function regionIntersectsBbox(
  regionBbox: NormalizedBbox,
  cropBbox: NormalizedBbox
): boolean {
  const inter = intersectionArea(regionBbox, cropBbox);
  const area = regionArea(regionBbox);
  if (area <= 0) return false;
  return inter / area >= REGION_OVERLAP_MIN;
}

export function filterRegionsInsideBbox(
  regions: TextRegion[],
  cropBbox: NormalizedBbox
): TextRegion[] {
  const crop = clampBbox(cropBbox);
  if (!crop) return [];
  return regions.filter((r) => regionIntersectsBbox(r.bbox, crop));
}

export function remapRegionsToCrop(
  regions: TextRegion[],
  cropBbox: NormalizedBbox
): TextRegion[] {
  const crop = clampBbox(cropBbox);
  if (!crop) return [];
  const [cx, cy, cw, ch] = crop;
  if (cw <= 0 || ch <= 0) return [];

  const out: TextRegion[] = [];
  for (const r of regions) {
    const [rx, ry, rw, rh] = r.bbox;
    const x = (rx - cx) / cw;
    const y = (ry - cy) / ch;
    const w = rw / cw;
    const h = rh / ch;
    if (x + w <= 0 || y + h <= 0 || x >= 1 || y >= 1) continue;
    const clamped: NormalizedBbox = [
      Math.max(0, Math.min(1, x)),
      Math.max(0, Math.min(1, y)),
      Math.max(0.001, Math.min(1 - Math.max(0, x), w)),
      Math.max(0.001, Math.min(1 - Math.max(0, y), h)),
    ];
    out.push({ id: r.id, text: r.text, bbox: clamped });
  }
  return out;
}
