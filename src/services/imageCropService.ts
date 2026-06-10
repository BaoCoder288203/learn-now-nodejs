import sharp from "sharp";
import type { NormalizedBbox } from "./ai/types.js";
import { clampBbox } from "./imageCropBbox.js";

export {
  clampBbox,
  filterRegionsInsideBbox,
  remapRegionsToCrop,
  regionIntersectsBbox,
} from "./imageCropBbox.js";

export async function cropPngBuffer(png: Buffer, bbox: NormalizedBbox): Promise<Buffer> {
  const crop = clampBbox(bbox);
  if (!crop) {
    throw new Error("cropPngBuffer: invalid bbox");
  }
  const [cx, cy, cw, ch] = crop;
  const meta = await sharp(png).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 1 || height < 1) {
    throw new Error("cropPngBuffer: invalid image dimensions");
  }

  const left = Math.round(cx * width);
  const top = Math.round(cy * height);
  const cropWidth = Math.max(1, Math.round(cw * width));
  const cropHeight = Math.max(1, Math.round(ch * height));

  return sharp(png)
    .extract({
      left: Math.min(left, width - 1),
      top: Math.min(top, height - 1),
      width: Math.min(cropWidth, width - left),
      height: Math.min(cropHeight, height - top),
    })
    .png()
    .toBuffer();
}
