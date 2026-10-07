// dsh:logging-exempt (shim layer: pure codecs, no logging surface of its own)
'use strict';
/**
 * PNG face of the sharp shim. Decode = chunk walk + the VENDORED pngjs
 * pixel stages (filter-parse-sync → bitmapper → format-normaliser, the
 * pinned 5.0.0 bytes doing every hard step verbatim); encode = filter-0
 * scanlines + fflate zlib + our chunk writer (with optional iCCP/tEXt
 * metadata chunks). 16-bit images keep their samples: bitmapper returns a
 * Uint16Array RGBA for depth 16 and the format normaliser is deliberately
 * bypassed there (it rescales to 8-bit — the sharp rgb16 face needs depth
 * preserved for the attachment normalization rules).
 *
 * The fflate require is by absolute staged path — same bundle root every
 * other shim import spells (/vendor/npm/...), so it resolves identically on
 * the dsh cjs-loader and plain node.
 */
const bytes = require('./bytes.js');

const FFLATE = '/vendor/npm/fflate@0.8.2/lib/index.cjs';
const PNG_LIB = '/vendor/npm/pngjs@5.0.0/lib';
const fflate = require(FFLATE);
const filterSync = require(PNG_LIB + '/filter-parse-sync.js');
const bitmapper = require(PNG_LIB + '/bitmapper.js');
const formatNormaliser = require(PNG_LIB + '/format-normaliser.js');
const pngConstants = require(PNG_LIB + '/constants.js');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BPP = pngConstants.COLORTYPE_TO_BPP_MAP; // colorType → samples per pixel

/** Validate + apply one IHDR body onto the parse record. */
function applyPngIhdr(info, data, bodyStart) {
  info.width = bytes.u32be(data, bodyStart);
  info.height = bytes.u32be(data, bodyStart + 4);
  info.depth = data[bodyStart + 8];
  info.colorType = data[bodyStart + 9];
  const compression = data[bodyStart + 10];
  const filterMethod = data[bodyStart + 11];
  info.interlace = data[bodyStart + 12];
  if (info.width <= 0 || info.height <= 0) throw new Error('png: bad IHDR dimensions');
  if (compression !== 0 || filterMethod !== 0) throw new Error('png: unsupported IHDR methods');
  if (BPP[info.colorType] === undefined) throw new Error(`png: unsupported color type ${info.colorType}`);
  if (![1, 2, 4, 8, 16].includes(info.depth)) throw new Error(`png: unsupported bit depth ${info.depth}`);
  if (info.colorType === 3 && info.depth === 16) throw new Error('png: 16-bit palette is invalid');
}

/** PLTE body → palette triples (opaque until a tRNS says otherwise). */
function readPngPalette(data, bodyStart, bodyEnd) {
  const palette = [];
  for (let at = bodyStart; at + 2 < bodyEnd; at += 3) {
    palette.push([data[at], data[at + 1], data[at + 2], 0xff]);
  }
  return palette;
}

/** Parse PNG chunks up to IEND: header facts + ancillary metadata + IDAT list. */
function parsePng(data) {
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== PNG_SIGNATURE[i]) throw new Error('png: bad signature');
  }
  const info = {
    width: 0, height: 0, depth: 8, colorType: 6, interlace: 0,
    palette: undefined, transColor: undefined, trnsRaw: undefined,
    icc: undefined, comments: [], exif: false,
    idat: [],
  };
  let at = 8;
  let sawIhdr = false;
  let sawIend = false;
  while (at + 8 <= data.length) {
    const length = bytes.u32be(data, at);
    const type = bytes.fourcc(data, at + 4);
    const bodyStart = at + 8;
    const bodyEnd = bodyStart + length;
    if (bodyEnd + 4 > data.length) throw new Error(`png: truncated ${type} chunk`);
    if (type === 'IHDR') {
      applyPngIhdr(info, data, bodyStart);
      sawIhdr = true;
    } else if (type === 'PLTE') {
      info.palette = readPngPalette(data, bodyStart, bodyEnd);
    } else if (type === 'tRNS') {
      info.trnsRaw = bytes.concat([data.subarray(bodyStart, bodyEnd)]);
    } else if (type === 'iCCP') {
      // name\0 compression-method zlib'd-profile — presence is the fact the
      // sharp face reports (icc profile); the payload is not interpreted.
      const nul = data.indexOf(0, bodyStart);
      if (nul > bodyStart && nul < bodyEnd) info.icc = 'iccp';
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const nul = data.indexOf(0, bodyStart);
      if (nul > bodyStart) info.comments.push(String.fromCharCode(...data.subarray(bodyStart, nul)));
    } else if (type === 'eXIf') {
    } else if (type === 'IDAT') {
      info.idat.push(data.subarray(bodyStart, bodyEnd));
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
    at = bodyEnd + 4; // skip CRC
  }
  if (!sawIhdr) throw new Error('png: no IHDR');
  if (info.colorType === 3 && !info.palette) throw new Error('png: palette image has no PLTE');
  info.sawIend = sawIend;
  applyPngTransparency(info);
  return info;
}

/** Derive the transColor fact from a tRNS body (pngjs's own model: the
 * first fully-transparent palette entry becomes the transColor triple —
 * partial palette alphas are not representable; gray/RGB spellings carry
 * the 16-bit sample(s) verbatim). */
function applyPngTransparency(info) {
  if (info.trnsRaw === undefined) return;
  if (info.colorType === 3) {
    for (let i = 0; i < info.trnsRaw.length && i < info.palette.length; i += 1) {
      if (info.trnsRaw[i] === 0) {
        info.transColor = info.palette[i].slice(0, 3);
        break;
      }
    }
  } else if (info.colorType === 0 && info.trnsRaw.length >= 2) {
    info.transColor = [(info.trnsRaw[0] << 8) | info.trnsRaw[1]];
  } else if (info.colorType === 2 && info.trnsRaw.length >= 6) {
    info.transColor = [
      (info.trnsRaw[0] << 8) | info.trnsRaw[1],
      (info.trnsRaw[2] << 8) | info.trnsRaw[3],
      (info.trnsRaw[4] << 8) | info.trnsRaw[5],
    ];
  }
}

/** Header-only facts (no IDAT inflate). */
function pngMetadata(data) {
  const info = parsePng(data);
  return {
    format: 'png',
    width: info.width,
    height: info.height,
    depth: info.depth === 16 ? 'ushort' : 'uchar',
    space: info.depth === 16 ? 'rgb16' : 'srgb',
    hasAlpha: info.colorType === 4 || info.colorType === 6 || info.transColor !== undefined,
    pages: 1,
    icc: info.icc,
    comments: info.comments,
    exif: info.exif,
  };
}

/** Full pixel decode. Returns interleaved RGBA in a Uint8Array (8-bit) or
 * Uint16Array (16-bit, full-range samples). Palette/tRNS ride the vendored
 * normaliser at 8-bit; 16-bit keeps pngjs's native Uint16Array output.
 * A stream whose chunk walk ended without IEND is a truncated payload and
 * is refused here (the header-only metadata face stays lenient — the sharp
 * probe contract reads partial headers fine). */
function pngDecode(data) {
  const info = parsePng(data);
  if (!info.sawIend) throw new Error('png: truncated stream (no IEND)');
  if (info.idat.length === 0) throw new Error('png: no IDAT');
  const raw = fflate.unzlibSync(bytes.concat(info.idat));
  const bitmapInfo = {
    width: info.width,
    height: info.height,
    depth: info.depth,
    bpp: BPP[info.colorType],
    interlace: info.interlace,
    palette: info.palette,
    transColor: info.transColor,
    colorType: info.colorType,
  };
  const unfiltered = filterSync.process(raw, bitmapInfo);
  const bitmap = bitmapper.dataToBitMap(unfiltered, bitmapInfo);
  if (info.depth === 16) {
    // bitmapper's native 16-bit path: Uint16Array RGBA, opaque = max sample.
    // Palette/tRNS are 8-bit-only concepts; 16-bit tRNS zero-matches here.
    if (info.transColor !== undefined && (info.colorType === 0 || info.colorType === 2)) {
      const tc = info.transColor;
      for (let px = 0; px < info.width * info.height; px += 1) {
        const base = px * 4;
        if (bitmap[base] === tc[0] && (tc.length === 1 || (bitmap[base + 1] === tc[1] && bitmap[base + 2] === tc[2]))) {
          bitmap[base] = 0; bitmap[base + 1] = 0; bitmap[base + 2] = 0; bitmap[base + 3] = 0;
        }
      }
    }
    return {
      data: bitmap, width: info.width, height: info.height, channels: 4,
      depth: 16, space: 'rgb16',
      hasAlpha: info.colorType === 4 || info.colorType === 6 || info.transColor !== undefined,
    };
  }
  const normalised = formatNormaliser(bitmap, bitmapInfo);
  let hasAlpha = info.colorType === 4 || info.colorType === 6 || info.transColor !== undefined;
  return {
    data: normalised, width: info.width, height: info.height, channels: 4,
    depth: 8, space: 'srgb', hasAlpha,
  };
}

/** Write one PNG chunk: length + type + body + CRC. */
function writeChunk(type, body) {
  const chunk = new Uint8Array(12 + body.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length, false);
  for (let i = 0; i < 4; i += 1) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(body, 8);
  view.setUint32(8 + body.length, bytes.crc32(chunk, 4, 8 + body.length), false);
  return chunk;
}

/** A minimal-but-shaped ICC placeholder for withIccProfile(name): the runtime
 * has no colour-profile store, so the named profile rides as a header-only
 * ICC payload whose description names the shim. Presence — not colour
 * transformation — is the contract the attachment family exercises. */
function placeholderIccProfile(name) {
  const profile = new Uint8Array(132);
  const view = new DataView(profile.buffer);
  view.setUint32(0, 132, false); // size
  view.setUint32(4, 0x64657368, false); // preferred CMM 'dsh '
  view.setUint32(8, 0x04300000, false); // version 4.3
  view.setUint32(12, 0x6d6e7472, false); // class 'mntr'
  view.setUint32(16, 0x52474220, false); // data space 'RGB '
  view.setUint32(20, 0x58595a20, false); // PCS 'XYZ '
  view.setUint32(36, 0x61637370, false); // 'acsp'
  const desc = `DSH sharp shim placeholder profile (${name})`;
  const limit = Math.min(desc.length, 132 - 44);
  for (let i = 0; i < limit; i += 1) profile[44 + i] = desc.charCodeAt(i);
  return profile;
}

/** Pack one filter-0 scanline: samples ride big-endian at the image depth;
 * the source is ALWAYS interleaved RGBA — `channels` (3) drops alpha. */
function packPngScanline(raw, rowAt, samples, pxStart, width, channels, depth) {
  raw[rowAt] = 0; // filter type None — the deterministic baseline
  let out = rowAt + 1;
  for (let px = pxStart; px < pxStart + width; px += 1) {
    for (let c = 0; c < channels; c += 1) {
      const sample = samples[px * 4 + c] & 0xFFFF;
      if (depth === 16) {
        raw[out] = (sample >> 8) & 0xFF;
        raw[out + 1] = sample & 0xFF;
        out += 2;
      } else {
        raw[out] = sample & 0xFF;
        out += 1;
      }
    }
  }
}

/** Encode interleaved RGBA (8- or 16-bit samples) as PNG. samples: the
 * full-range value array (0..255 or 0..65535); channels 3 drops alpha. */
function pngEncode(image, options = {}) {
  const { width, height, channels, depth } = image;
  const samples = image.data;
  if (samples.length < width * height * channels) throw new Error('png: pixel buffer smaller than its dimensions');
  const colorType = channels === 4 ? 6 : 2;
  const stride = width * channels * (depth === 16 ? 2 : 1);
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    packPngScanline(raw, y * (stride + 1), samples, y * width, width, channels, depth);
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  const chunks = [
    bytes.concat([PNG_SIGNATURE]),
    writeChunk('IHDR', ihdr),
  ];
  if (options.iccProfileName !== undefined) {
    const name = bytes.concat([Uint8Array.from(options.iccProfileName.split('').map((c) => c.charCodeAt(0))), Uint8Array.of(0, 0)]);
    const compressed = fflate.zlibSync(placeholderIccProfile(options.iccProfileName));
    chunks.push(writeChunk('iCCP', bytes.concat([name, compressed])));
  }
  if (options.softwareText) {
    const text = bytes.concat([
      Uint8Array.from('Software'.split('').map((c) => c.charCodeAt(0))), Uint8Array.of(0),
      Uint8Array.from('sharp'.split('').map((c) => c.charCodeAt(0))),
    ]);
    chunks.push(writeChunk('tEXt', text));
  }
  chunks.push(writeChunk('IDAT', fflate.zlibSync(raw)));
  chunks.push(writeChunk('IEND', new Uint8Array(0)));
  return bytes.concat(chunks);
}

exports.pngMetadata = pngMetadata;
exports.pngDecode = pngDecode;
exports.pngEncode = pngEncode;
