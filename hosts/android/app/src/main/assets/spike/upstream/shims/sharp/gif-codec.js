// dsh:logging-exempt (shim layer: pure codecs, no logging surface of its own)
'use strict';
/**
 * GIF face of the sharp shim — hand-written LZW codec (the family needs GIF
 * decode for read-image fixtures plus GIF encode for normalization fixtures;
 * no upstream pure-JS GIF codec is vendored, so this module is ours, CJS,
 * no imports beyond ./bytes.js).
 *
 * Decode semantics follow libvips gifload — the behavior the vendored
 * attachment code documents and asserts: every GIF decodes to RGBA, so
 * metadata.hasAlpha is TRUE for any GIF (still or animated), and pages
 * counts the painted frames (animated = pages > 1).
 */
const bytes = require('./bytes.js');

/** One LZW decode state: dict, code width, bit reader, output cursor. */
function lzwState(minCodeSize, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const dict = [];
  for (let i = 0; i < clearCode; i += 1) dict[i] = [i];
  dict[clearCode] = []; // clear
  dict[clearCode + 1] = []; // end-of-information
  return {
    clearCode, eoiCode: clearCode + 1, dict,
    codeSize: minCodeSize + 1, prev: -1,
    bitBuffer: 0, bitCount: 0, at: 0,
    out: new Uint8Array(pixelCount), outAt: 0,
  };
}

/** Read the next code (or null at end-of-input). */
function lzwNextCode(state, data) {
  while (state.bitCount < state.codeSize) {
    if (state.at >= data.length) return null;
    state.bitBuffer |= data[state.at] << state.bitCount;
    state.bitCount += 8;
    state.at += 1;
  }
  const code = state.bitBuffer & ((1 << state.codeSize) - 1);
  state.bitBuffer >>= state.codeSize;
  state.bitCount -= state.codeSize;
  return code;
}

/** Resolve one code against the dictionary, painting samples + growing it. */
function lzwApplyCode(state, code) {
  let entry;
  if (code < state.dict.length) {
    entry = state.dict[code];
  } else if (state.prev >= 0 && code === state.dict.length) {
    entry = state.dict[state.prev].concat([state.dict[state.prev][0]]);
  } else {
    throw new Error('gif: bad LZW code');
  }
  for (const sample of entry) {
    if (state.outAt >= state.out.length) break;
    state.out[state.outAt] = sample;
    state.outAt += 1;
  }
  if (state.prev >= 0 && state.dict.length < 4096) {
    state.dict.push(state.dict[state.prev].concat([entry[0]]));
    if (state.dict.length === (1 << state.codeSize) && state.codeSize < 12) state.codeSize += 1;
  }
  state.prev = code;
}

/** Variable-width LZW decode of one frame's code stream. */
function lzwDecode(minCodeSize, data, pixelCount) {
  const state = lzwState(minCodeSize, pixelCount);
  for (;;) {
    const code = lzwNextCode(state, data);
    if (code === null || code === state.eoiCode) return state.out;
    if (code === state.clearCode) {
      state.codeSize = minCodeSize + 1;
      state.dict.length = 0;
      for (let i = 0; i < state.clearCode; i += 1) state.dict[i] = [i];
      state.dict[state.clearCode] = [];
      state.dict[state.clearCode + 1] = [];
      state.prev = -1;
      continue;
    }
    lzwApplyCode(state, code);
  }
}

/** Interlace pass row order (GIF89a §23). */
const INTERLACE_ROWS = (height) => {
  const rows = [];
  for (let y = 0; y < height; y += 8) rows.push(y);
  for (let y = 4; y < height; y += 8) rows.push(y);
  for (let y = 2; y < height; y += 4) rows.push(y);
  for (let y = 1; y < height; y += 2) rows.push(y);
  return rows;
};

/** Parse GIF structure; decode pixels for every frame (RGBA composite). */
/** Read the GCT (if present) starting at byte 13; returns { palette, at }. */
function readGlobalPalette(data) {
  const packed = data[10];
  let at = 13;
  if (!(packed & 0x80)) return { palette: null, at };
  const size = 2 << (packed & 0x07);
  const palette = [];
  for (let i = 0; i < size; i += 1) {
    palette.push([data[at], data[at + 1], data[at + 2], 0xff]);
    at += 3;
  }
  return { palette, at };
}

/** Walk the block stream: extensions (GCE transparency) + image frames. */
/** Skip one extension's sub-block run; returns the offset past it. */
function skipSubBlocks(data, at) {
  while (at < data.length) {
    const sub = data[at];
    at += 1;
    if (sub === 0) break;
    at += sub;
  }
  return at;
}

/** Read one image descriptor + its LZW pixels; returns { frame, at }. */
function readGifFrame(data, at, globalPalette, transparentIndex) {
  const packed = data[at + 8];
  const frameW = bytes.u16le(data, at + 4);
  const frameH = bytes.u16le(data, at + 6);
  let palette = globalPalette;
  at += 9;
  if (packed & 0x80) {
    const size = 2 << (packed & 0x07);
    palette = [];
    for (let i = 0; i < size; i += 1) {
      palette.push([data[at], data[at + 1], data[at + 2], 0xff]);
      at += 3;
    }
  }
  const minCodeSize = data[at];
  at += 1;
  const codeEnd = skipSubBlocks(data, at);
  const codeBytes = [];
  while (at < codeEnd) {
    const sub = data[at];
    at += 1;
    codeBytes.push(data.subarray(at, at + sub));
    at += sub;
  }
  const pixels = lzwDecode(minCodeSize, bytes.concat(codeBytes), frameW * frameH);
  return {
    frame: { width: frameW, height: frameH, pixels, palette, interlaced: (packed & 0x40) !== 0, transparentIndex },
    at: codeEnd,
  };
}

/** Walk the block stream: extensions (GCE transparency) + image frames. */
function parseGifBlocks(data, globalPalette) {
  let at = globalPalette.at;
  let transparentIndex = -1;
  const frames = [];
  for (;;) {
    if (at >= data.length) break;
    const block = data[at];
    at += 1;
    if (block === 0x3B) break; // trailer
    if (block === 0x21) { // extension
      const label = data[at];
      at += 1;
      if (label === 0xF9) {
        at += 1; // block size (4)
        const flags = data[at];
        transparentIndex = (flags & 0x01) ? data[at + 3] : -1;
        at += 4;
        at += 1; // block terminator
      } else {
        at = skipSubBlocks(data, at);
      }
      continue;
    }
    if (block === 0x2C) { // image descriptor
      const parsed = readGifFrame(data, at, globalPalette.palette, transparentIndex);
      frames.push(parsed.frame);
      at = parsed.at;
      continue;
    }
    throw new Error(`gif: unknown block 0x${block.toString(16)}`);
  }
  return frames;
}

function gifDecode(data) {
  if (!bytes.asciiAt(data, 0, 'GIF87a') && !bytes.asciiAt(data, 0, 'GIF89a')) {
    throw new Error('gif: bad header');
  }
  const width = bytes.u16le(data, 6);
  const height = bytes.u16le(data, 8);
  const frames = parseGifBlocks(data, readGlobalPalette(data));
  if (frames.length === 0) throw new Error('gif: no frames');
  // Composite onto an RGBA canvas, first frame wins per pixel for opaque
  // paint (matches libvips's first-frame-first compositing for stills).
  const out = new Uint8Array(width * height * 4); // transparent black
  for (const frame of frames) {
    const rows = frame.interlaced ? INTERLACE_ROWS(frame.height) : null;
    for (let fy = 0; fy < frame.height; fy += 1) {
      const cy = rows ? rows[fy] : fy;
      for (let fx = 0; fx < frame.width; fx += 1) {
        const index = frame.pixels[fy * frame.width + fx];
        if (index === frame.transparentIndex) continue;
        const color = frame.palette[index];
        if (!color) throw new Error('gif: pixel index outside palette');
        const target = (cy * width + fx) * 4;
        out[target] = color[0];
        out[target + 1] = color[1];
        out[target + 2] = color[2];
        out[target + 3] = 0xff;
      }
    }
  }
  return {
    data: out,
    width, height, channels: 4, depth: 8, space: 'srgb',
    hasAlpha: true, // libvips gifload semantics: GIF is always RGBA
    pages: frames.length,
  };
}

function gifMetadata(data) {
  const decoded = gifDecode(data);
  return {
    format: 'gif',
    width: decoded.width,
    height: decoded.height,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: true,
    pages: decoded.pages,
  };
}

/** u16 little-endian write. */
const u16le = (out, at, value) => {
  out[at] = value & 0xFF;
  out[at + 1] = (value >> 8) & 0xFF;
};

/** Palette building: exact palette when ≤256 unique colors, else a uniform
 * 3-3-2 reduction (the fixtures' flat fields hit the exact path). */
/** The uniform 3-3-2 fallback palette (256 entries) + quantized indices. */
function quantizeTo256(data, width, height) {
  const keys = new Map();
  for (let r = 0; r < 8; r += 1) {
    for (let g = 0; g < 8; g += 1) {
      for (let b = 0; b < 4; b += 1) {
        keys.set((r << 21) | (g << 18) | (b << 16), keys.size);
      }
    }
  }
  const indices = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p += 1) {
    const base = p * 4;
    const r = data[base] >> 5;
    const g = data[base + 1] >> 5;
    const b = data[base + 2] >> 6;
    indices[p] = keys.get((r << 21) | (g << 18) | (b << 16));
  }
  return { indices, keys };
}

/** Palette of the unique colors in scan order (caller guarantees ≤256). */
function paletteOf(unique) {
  const palette = [];
  for (const key of unique.keys()) {
    palette.push([(key >> 16) & 0xFF, (key >> 8) & 0xFF, key & 0xFF, 0xff]);
  }
  return palette;
}

/** Palette building: exact palette when ≤256 unique colors, else the
 * uniform 3-3-2 reduction (the fixtures' flat fields hit the exact path). */
function buildPalette(data, width, height) {
  const unique = new Map();
  let opaque = true;
  for (let px = 0; px < width * height; px += 1) {
    const at = px * 4;
    if (data[at + 3] !== 255) opaque = false;
    const key = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2];
    if (!unique.has(key)) unique.set(key, unique.size);
    if (unique.size > 256) {
      const q = quantizeTo256(data, width, height);
      return { indices: q.indices, palette: paletteOf(q.keys), opaque };
    }
  }
  const indices = new Uint8Array(width * height);
  for (let px = 0; px < width * height; px += 1) {
    const at = px * 4;
    indices[px] = unique.get((data[at] << 16) | (data[at + 1] << 8) | data[at + 2]);
  }
  return { indices, palette: paletteOf(unique), opaque };
}

/** Variable-width LZW encode (GIF flavour: codes packed LSB-first). The
 * code width grows with the dictionary — packing interleaves with
 * generation so each code rides the width in force when it was emitted. */
function lzwEncode(minCodeSize, indices) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map();
  const resetDict = () => {
    dict = new Map();
    for (let i = 0; i < clearCode; i += 1) dict.set(String.fromCharCode(i), i);
  };
  resetDict();
  const byteList = [];
  let bitBuffer = 0;
  let bitCount = 0;
  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      byteList.push(bitBuffer & 0xFF);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };
  emit(clearCode);
  let current = '';
  for (let i = 0; i < indices.length; i += 1) {
    const ch = String.fromCharCode(indices[i]);
    const next = current + ch;
    if (dict.has(next)) {
      current = next;
      continue;
    }
    emit(dict.get(current));
    if (dict.size < 4096) {
      dict.set(next, dict.size);
      if (dict.size === (1 << codeSize) && codeSize < 12) codeSize += 1;
    } else {
      emit(clearCode);
      codeSize = minCodeSize + 1;
      resetDict();
    }
    current = ch;
  }
  if (current.length > 0) emit(dict.get(current));
  emit(eoiCode);
  if (bitCount > 0) byteList.push(bitBuffer & 0xFF);
  return Uint8Array.from(byteList);
}

/** Encode RGBA pixels as a single-frame GIF89a. Transparency is written
 * only when the source actually carries non-opaque samples. */
function gifEncode(image) {
  const { width, height } = image;
  const data = image.data;
  const { indices, palette, opaque } = buildPalette(data, width, height);
  let transparentIndex = -1;
  if (!opaque) {
    transparentIndex = palette.length;
    palette.push([0, 0, 0, 0]);
  }
  let paletteBits = 1;
  while ((1 << paletteBits) < palette.length) paletteBits += 1;
  const paletteSize = 1 << paletteBits;
  const minCodeSize = Math.max(2, paletteBits);

  const header = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  const lsd = new Uint8Array(7);
  u16le(lsd, 0, width);
  u16le(lsd, 2, height);
  lsd[4] = 0x80 | (paletteBits - 1); // GCT present
  lsd[5] = 0; lsd[6] = 0;
  const gct = new Uint8Array(paletteSize * 3);
  for (let i = 0; i < palette.length; i += 1) {
    gct[i * 3] = palette[i][0];
    gct[i * 3 + 1] = palette[i][1];
    gct[i * 3 + 2] = palette[i][2];
  }
  const parts = [header, lsd, gct];
  if (transparentIndex >= 0) {
    parts.push(Uint8Array.from([0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, transparentIndex & 0xFF, 0x00]));
  }
  const idParts = [Uint8Array.from([0x2C])];
  const id = new Uint8Array(9);
  u16le(id, 0, 0); u16le(id, 2, 0); u16le(id, 4, width); u16le(id, 6, height);
  id[8] = 0;
  idParts.push(id, Uint8Array.of(minCodeSize));
  const codes = lzwEncode(minCodeSize, indices);
  for (let at = 0; at < codes.length; at += 255) {
    const slice = codes.subarray(at, Math.min(at + 255, codes.length));
    idParts.push(Uint8Array.of(slice.length), slice);
  }
  idParts.push(Uint8Array.of(0));
  parts.push(bytes.concat(idParts), Uint8Array.of(0x3B));
  return bytes.concat(parts);
}

exports.gifMetadata = gifMetadata;
exports.gifDecode = gifDecode;
exports.gifEncode = gifEncode;
