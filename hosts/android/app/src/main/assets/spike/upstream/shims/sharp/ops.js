// dsh:logging-exempt (shim layer: pure pixel ops, no logging surface of its own)
'use strict';
/**
 * Pixel operations for the sharp face's pipeline (split from index.js when
 * that file crossed the code-size budget): EXIF orientation baking, the
 * area/bilinear resampler, depth and colourspace conversions, greyscale and
 * alpha removal. Every op is pure — it takes an image record
 * ({data, width, height, channels, depth, space, hasAlpha, orientation})
 * and returns a NEW one; ops never mutate shared state.
 */

/** Per-orientation source-pixel mapping: orientation (EXIF 1-8) → a function
 * (x, y, W, H) → [dx, dy] on the DESTINATION canvas. Orientations 5-8
 * transpose the stored raster. */
const ORIENTATION_MAP = {
  1: (x, y) => [x, y],
  2: (x, y, W) => [W - 1 - x, y], // flip horizontal
  3: (x, y, W, H) => [W - 1 - x, H - 1 - y], // rotate 180
  4: (x, y, W, H) => [x, H - 1 - y], // flip vertical
  5: (x, y) => [y, x], // transpose
  6: (x, y, W, H) => [H - 1 - y, x], // rotate 90 CW
  7: (x, y, W, H) => [H - 1 - y, W - 1 - x], // transverse
  8: (x, y, W) => [y, W - 1 - x], // rotate 270 CW
};

/** Apply one EXIF orientation (1-8) to an RGBA pixel buffer. */
function applyOrientation(image, orientation) {
  const map = ORIENTATION_MAP[orientation] ?? ORIENTATION_MAP[1];
  const { width, height, data } = image;
  const out = new data.constructor(width * height * 4);
  // Destination row stride: orientations 5-8 transpose the canvas (its width
  // becomes the SOURCE height); 1-4 keep width×height. Hardcoding one stride
  // misplaces or drops pixels on every non-square image (caught in review on
  // a 3×2, R-channel=index probe: orientation 3 read 5,4,3,1,0,0).
  const destStride = orientation >= 5 ? height : width;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      const [dx, dy] = map(x, y, width, height);
      const dst = (dy * destStride + dx) * 4;
      for (let c = 0; c < 4; c += 1) out[dst + c] = data[src + c];
    }
  }
  const rotated = orientation >= 5;
  return {
    data: out,
    width: rotated ? height : width,
    height: rotated ? width : height,
    channels: 4,
    depth: image.depth,
    space: image.space,
    hasAlpha: image.hasAlpha,
    orientation: undefined,
  };
}

/** One destination pixel's box-filter average over its source rect. */
function boxSample(data, width, height, x0, x1, y0, y1) {
  let r = 0; let g = 0; let b = 0; let a = 0; let count = 0;
  for (let sy = Math.floor(y0); sy < Math.min(height, Math.ceil(y1)); sy += 1) {
    for (let sx = Math.floor(x0); sx < Math.min(width, Math.ceil(x1)); sx += 1) {
      const at = (sy * width + sx) * 4;
      r += data[at]; g += data[at + 1]; b += data[at + 2]; a += data[at + 3];
      count += 1;
    }
  }
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count), Math.round(a / count)];
}

/** One destination pixel's bilinear sample. */
function bilinearSample(data, width, height, fx, fy) {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const wx = fx - x0;
  const wy = fy - y0;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c += 1) {
    const p00 = data[(y0 * width + x0) * 4 + c];
    const p01 = data[(y0 * width + x1) * 4 + c];
    const p10 = data[(y1 * width + x0) * 4 + c];
    const p11 = data[(y1 * width + x1) * 4 + c];
    const top = p00 + (p01 - p00) * wx;
    const bottom = p10 + (p11 - p10) * wx;
    out[c] = Math.round(top + (bottom - top) * wy);
  }
  return out;
}

/** Area-average downscale / bilinear upscale to exact target dimensions.
 * Works for 8- and 16-bit sample arrays (constructor-selected). */
function resizePixels(image, targetW, targetH) {
  const { width, height, data } = image;
  if (width === targetW && height === targetH) return image;
  const out = new data.constructor(targetW * targetH * 4);
  const scaleDown = targetW <= width && targetH <= height;
  for (let ty = 0; ty < targetH; ty += 1) {
    const fy = scaleDown ? ((ty + 0.5) * height) / targetH - 0.5 : (ty * (height - 1)) / Math.max(1, targetH - 1);
    for (let tx = 0; tx < targetW; tx += 1) {
      const sample = scaleDown
        ? boxSample(data, width, height, (tx * width) / targetW, ((tx + 1) * width) / targetW, (ty * height) / targetH, ((ty + 1) * height) / targetH)
        : bilinearSample(data, width, height, (tx * (width - 1)) / Math.max(1, targetW - 1), fy);
      const dst = (ty * targetW + tx) * 4;
      for (let c = 0; c < 4; c += 1) out[dst + c] = sample[c];
    }
  }
  return { ...image, data: out, width: targetW, height: targetH };
}

/** 16→8 bit sample conversion ((v*255 + 32767) >> 16 — round-half-up). */
function depthTo8(image) {
  if (image.depth === 8) return image;
  const src = image.data;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = (src[i] * 255 + 32767) >> 16;
  return { ...image, data: out, depth: 8, space: image.space === 'rgb16' ? 'srgb' : image.space };
}

/** 8→16 bit (v*257) for the rgb16 output colourspace. */
function depthTo16(image) {
  if (image.depth === 16) return image;
  const src = image.data;
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = src[i] * 257;
  return { ...image, data: out, depth: 16, space: 'rgb16' };
}

function greyscalePixels(image) {
  const src = image.data;
  const out = new src.constructor(src.length);
  for (let px = 0; px < src.length; px += 4) {
    const luma = Math.round(0.299 * src[px] + 0.587 * src[px + 1] + 0.114 * src[px + 2]);
    out[px] = luma;
    out[px + 1] = luma;
    out[px + 2] = luma;
    out[px + 3] = src[px + 3];
  }
  return { ...image, data: out };
}

function dropAlpha(image) {
  const src = image.data;
  for (let px = 3; px < src.length; px += 4) src[px] = 255;
  return { ...image, hasAlpha: false };
}

module.exports = { applyOrientation, resizePixels, depthTo8, depthTo16, greyscalePixels, dropAlpha };
