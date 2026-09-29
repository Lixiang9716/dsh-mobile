// dsh:logging-exempt (shim layer: pure codecs, no logging surface of its own)
'use strict';
/**
 * SVG face of the sharp shim — a SUBSET rasterizer, and the one honest place
 * this adaptation draws a boundary: real SVG rasterization needs a font
 * stack and a geometry engine, and the QuickJS runtime has neither. What the
 * face implements: canvas sizing from the svg element (width/height attrs,
 * viewBox fallback), <rect> fills, and <text> via a built-in public-domain
 * 5x7 bitmap font scaled to font-size — deliberately NOT antialiased and
 * metric-free. Unknown elements are skipped by contract (documented gap,
 * rule 5 for the face as a whole, not per element).
 */
const bytes = require('./bytes.js');

/** Classic 5x7 bitmap font, ASCII 32..126, rows top→bottom as 5-bit values. */
const FONT_5X7 = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '!': [4, 4, 4, 4, 4, 0, 4],
  '"': [10, 10, 0, 0, 0, 0, 0],
  '#': [10, 10, 31, 10, 31, 10, 10],
  '$': [4, 15, 20, 14, 5, 30, 4],
  '%': [25, 26, 2, 4, 8, 11, 19],
  '&': [12, 18, 20, 8, 21, 18, 13],
  "'": [4, 4, 0, 0, 0, 0, 0],
  '(': [2, 4, 8, 8, 8, 4, 2],
  ')': [8, 4, 2, 2, 2, 4, 8],
  '*': [0, 4, 21, 14, 31, 14, 21],
  '+': [0, 4, 4, 31, 4, 4, 0],
  ',': [0, 0, 0, 0, 12, 4, 8],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 12, 12],
  '/': [1, 1, 2, 4, 8, 16, 16],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 6, 8, 16, 31],
  '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  ':': [0, 12, 12, 0, 12, 12, 0],
  ';': [0, 12, 12, 0, 12, 4, 8],
  '<': [2, 4, 8, 16, 8, 4, 2],
  '=': [0, 0, 31, 0, 31, 0, 0],
  '>': [8, 4, 2, 1, 2, 4, 8],
  '?': [14, 17, 1, 2, 4, 0, 4],
  '@': [14, 17, 23, 21, 23, 16, 14],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  '[': [14, 8, 8, 8, 8, 8, 14],
  '\\': [16, 16, 8, 4, 2, 1, 1],
  ']': [14, 2, 2, 2, 2, 2, 14],
  '^': [4, 4, 10, 17, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 31],
  '`': [8, 4, 2, 0, 0, 0, 0],
  a: [0, 0, 14, 1, 15, 17, 15],
  b: [16, 16, 30, 17, 17, 17, 30],
  c: [0, 0, 15, 16, 16, 16, 15],
  d: [1, 1, 15, 17, 17, 17, 15],
  e: [0, 0, 14, 17, 31, 16, 14],
  f: [6, 8, 8, 30, 8, 8, 8],
  g: [0, 0, 15, 17, 15, 1, 14],
  h: [16, 16, 30, 17, 17, 17, 17],
  i: [4, 0, 12, 4, 4, 4, 14],
  j: [2, 0, 6, 2, 2, 18, 12],
  k: [16, 16, 18, 20, 24, 20, 19],
  l: [12, 4, 4, 4, 4, 4, 14],
  m: [0, 0, 26, 21, 21, 21, 21],
  n: [0, 0, 30, 17, 17, 17, 17],
  o: [0, 0, 14, 17, 17, 17, 14],
  p: [0, 0, 30, 17, 30, 16, 16],
  q: [0, 0, 15, 17, 15, 1, 1],
  r: [0, 0, 22, 25, 16, 16, 16],
  s: [0, 0, 15, 16, 14, 1, 30],
  t: [8, 8, 30, 8, 8, 8, 6],
  u: [0, 0, 17, 17, 17, 19, 13],
  v: [0, 0, 17, 17, 17, 10, 4],
  w: [0, 0, 17, 21, 21, 21, 10],
  x: [0, 0, 17, 10, 4, 10, 17],
  y: [0, 0, 17, 17, 15, 1, 14],
  z: [0, 0, 31, 2, 4, 8, 31],
  '{': [6, 4, 4, 12, 4, 4, 6],
  '|': [4, 4, 4, 4, 4, 4, 4],
  '}': [12, 4, 4, 6, 4, 4, 12],
  '~': [0, 0, 8, 21, 2, 0, 0],
};
const FONT_UNKNOWN = [31, 21, 21, 21, 21, 31, 0];

/** Named/attribute colors the subset renderer resolves; anything else is
 * black (the safe contrast direction for text). */
const NAMED_COLORS = {
  white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0],
  green: [0, 128, 0], blue: [0, 0, 255], gray: [128, 128, 128],
  grey: [128, 128, 128], yellow: [255, 255, 0], none: null,
};

function parseColor(spec) {
  if (spec === undefined) return [0, 0, 0];
  const value = spec.trim().toLowerCase();
  if (NAMED_COLORS[value] !== undefined) return NAMED_COLORS[value];
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
    }
    if (hex.length >= 6) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
  }
  return [0, 0, 0];
}

/** Dimension attribute: unitless, px, pt/mm/in (96dpi normalization), %. */
function parseLength(spec, viewBoxFallback) {
  if (spec === undefined) return undefined;
  const match = /^\s*([0-9.]+)\s*(px|pt|pc|mm|cm|in|%)?\s*$/.exec(spec);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === undefined || unit === 'px') return value;
  if (unit === '%') return viewBoxFallback;
  const toPx = { pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
  return value * toPx[unit];
}

function svgHeader(text) {
  const svgAt = text.indexOf('<svg');
  if (svgAt < 0) throw new Error('svg: no <svg> element');
  const closeAt = text.indexOf('>', svgAt);
  if (closeAt < 0) throw new Error('svg: unterminated <svg>');
  return text.slice(svgAt, closeAt);
}

function attrOf(tag, name) {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return match ? (match[2] !== undefined ? match[2] : match[3]) : undefined;
}

function svgSize(text) {
  const tag = svgHeader(text);
  const viewBox = attrOf(tag, 'viewBox');
  let vbW;
  let vbH;
  if (viewBox !== undefined) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      vbW = parts[2];
      vbH = parts[3];
    }
  }
  const width = parseLength(attrOf(tag, 'width'), vbW);
  const height = parseLength(attrOf(tag, 'height'), vbH);
  if (width === undefined || height === undefined) {
    if (vbW === undefined || vbH === undefined) throw new Error('svg: no resolvable canvas size');
    return { width: vbW || 1, height: vbH || 1 };
  }
  return { width: width || 1, height: height || 1 };
}

function svgMetadata(data) {
  let text = '';
  for (let i = 0; i < Math.min(data.length, 4096); i += 1) text += String.fromCharCode(data[i]);
  const { width, height } = svgSize(text);
  return {
    format: 'svg', width: Math.round(width), height: Math.round(height),
    depth: 'uchar', space: 'srgb', hasAlpha: false, pages: 1,
  };
}

/** Paint one scale×scale font cell (clipped to the canvas). */
function paintGlyphCell(out, width, height, x0, y0, scale, color) {
  for (let dy = 0; dy < scale; dy += 1) {
    const py = y0 + dy;
    if (py < 0 || py >= height) continue;
    for (let dx = 0; dx < scale; dx += 1) {
      const px = x0 + dx;
      if (px < 0 || px >= width) continue;
      const at = (py * width + px) * 4;
      out[at] = color[0];
      out[at + 1] = color[1];
      out[at + 2] = color[2];
      out[at + 3] = 255;
    }
  }
}

/** Paint one scaled bitmap-font run: each glyph cell becomes scale×scale
 * solid pixels — legible, metric-free, unantialiased. */
function drawText(out, width, height, x, y, content, fontSize, color) {
  const scale = Math.max(1, Math.round(fontSize / 7));
  let penX = Math.round(x);
  const penY = Math.round(y - Math.round(fontSize));
  for (const ch of content) {
    const glyph = FONT_5X7[ch] ?? FONT_UNKNOWN;
    for (let row = 0; row < 7; row += 1) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col += 1) {
        if ((bits >> (4 - col)) & 1) {
          paintGlyphCell(out, width, height, penX + col * scale, penY + row * scale, scale, color);
        }
      }
    }
    penX += 6 * scale;
  }
}

function drawRect(out, width, height, x, y, w, h, color) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, Math.round(x + w));
  const y1 = Math.min(height, Math.round(y + h));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const at = (py * width + px) * 4;
      out[at] = color[0];
      out[at + 1] = color[1];
      out[at + 2] = color[2];
      out[at + 3] = 255;
    }
  }
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Rasterize the supported subset onto a white canvas (the SVG default
 * canvas is transparent; sharp's SVG load composites on white for JPEGs —
 * white is the flat-field face the family's assertions measure). */
function svgDecode(data) {
  let text = '';
  for (let i = 0; i < data.length; i += 1) text += String.fromCharCode(data[i]);
  const { width: w0, height: h0 } = svgSize(text);
  const width = Math.max(1, Math.round(w0));
  const height = Math.max(1, Math.round(h0));
  const out = new Uint8Array(width * height * 4);
  for (let px = 0; px < width * height; px += 1) {
    out[px * 4] = 255;
    out[px * 4 + 1] = 255;
    out[px * 4 + 2] = 255;
    out[px * 4 + 3] = 255;
  }
  const rectRe = /<rect\b([^>]*)\/?>/g;
  let match;
  while ((match = rectRe.exec(text)) !== null) {
    const tag = match[1];
    if ((attrOf(tag, 'fill') ?? '').trim() === 'none') continue;
    drawRect(out, width, height,
      Number(attrOf(tag, 'x') ?? 0), Number(attrOf(tag, 'y') ?? 0),
      Number(attrOf(tag, 'width') ?? width), Number(attrOf(tag, 'height') ?? height),
      parseColor(attrOf(tag, 'fill')));
  }
  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  while ((match = textRe.exec(text)) !== null) {
    const tag = match[1];
    const content = decodeEntities(match[2].replace(/<[^>]*>/g, '')).trim();
    if (content.length === 0) continue;
    const fontSize = Number(attrOf(tag, 'font-size') ?? 16);
    drawText(out, width, height,
      Number(attrOf(tag, 'x') ?? 0), Number(attrOf(tag, 'y') ?? fontSize),
      content, Number.isFinite(fontSize) ? fontSize : 16,
      parseColor(attrOf(tag, 'fill')));
  }
  return {
    data: out, width, height, channels: 4, depth: 8, space: 'srgb',
    hasAlpha: false,
  };
}

exports.svgMetadata = svgMetadata;
exports.svgDecode = svgDecode;
