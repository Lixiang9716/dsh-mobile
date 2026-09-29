'use strict';
/**
 * JPEG face of the sharp shim: the VENDORED jpeg-js 0.4.4 does the entropy
 * coding both ways; this module adds the container facts sharp's metadata
 * face reports — APP1 EXIF (orientation) written by withMetadata, an APP14
 * Adobe tag for the cmyk colourspace spelling (probe-visible only; pixels
 * stay the encoder's YCbCr), and a header-only marker walk so probeImage
 * never pays a full scan decode. A minimal TIFF writer serves the one role
 * unsupported formats play in the family: bytes that decode as nothing.
 */
const bytes = require('./bytes.js');

const JPEG_JS = '/vendor/npm/jpeg-js@0.4.4/index.js';
const jpegJs = require(JPEG_JS);

const EXIF_ORIENTATION_TAG = 0x0112;

/** Header-only facts: SOF dimensions + APP1 orientation + APP14 cmyk tag. */
function jpegMetadata(data) {
  if (!bytes.asciiAt(data, 0, '\xFF\xD8')) throw new Error('jpeg: bad SOI');
  const facts = {
    format: 'jpeg', width: 0, height: 0, depth: 'uchar', space: 'srgb',
    hasAlpha: false, pages: 1, orientation: undefined, exif: false,
    comments: [], icc: undefined,
  };
  let at = 2;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xFF) throw new Error(`jpeg: bad marker 0x${data[at].toString(16)} at ${at}`);
    const marker = data[at + 1];
    if (marker === 0xD9 || marker === 0xDA) break; // EOI / start of scan
    const length = bytes.u16be(data, at + 2);
    const bodyStart = at + 4;
    if (bodyStart - 2 + length > data.length) throw new Error('jpeg: truncated segment');
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      facts.height = bytes.u16be(data, bodyStart + 1);
      facts.width = bytes.u16be(data, bodyStart + 3);
      const components = data[bodyStart + 5];
      if (components === 4) {
        facts.space = 'cmyk';
        facts.hasAlpha = false;
      }
    } else if (marker === 0xE1 && bytes.asciiAt(data, bodyStart, 'Exif')) {
      // 'Exif\0\0' is the 6-byte TIFF header prefix
      const orientation = parseExifOrientation(data.subarray(bodyStart + 6, bodyStart - 2 + length));
      if (orientation !== undefined) facts.orientation = orientation;
      facts.exif = true;
    } else if (marker === 0xEE && bytes.asciiAt(data, bodyStart, 'Adobe')) {
      // APP14 Adobe: transform 2 = YCCK/CMYK spelling.
      if (length >= 13 && data[bodyStart + 11] === 2) facts.space = 'cmyk';
    } else if (marker === 0xE2 && bytes.asciiAt(data, bodyStart, 'ICC_PROFILE')) {
      facts.icc = 'icc';
    }
    at = bodyStart - 2 + length;
  }
  if (facts.width === 0 || facts.height === 0) throw new Error('jpeg: no SOF');
  return facts;
}

/** Orientation SHORT from the EXIF IFD0 (byte-order aware, minimal walk). */
function parseExifOrientation(tiff) {
  if (tiff.length < 8) return undefined;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const u16 = (o) => (little ? (tiff[o] | (tiff[o + 1] << 8)) : ((tiff[o] << 8) | tiff[o + 1]));
  const u32 = (o) => (little
    ? ((tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16)) + tiff[o + 3] * 0x1000000)
    : ((tiff[o] << 24) + (tiff[o + 1] << 16) + (tiff[o + 2] << 8) + tiff[o + 3]));
  if (u16(2) !== 0x2A) return undefined;
  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return undefined;
  const count = u16(ifd0);
  for (let e = 0; e < count; e += 1) {
    const entry = ifd0 + 2 + e * 12;
    if (entry + 12 > tiff.length) return undefined;
    if (u16(entry) === EXIF_ORIENTATION_TAG) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

/** Full decode via the vendored jpeg-js. The 0.4.4 decode returns the
 * native component interleaving (3-ch YCbCr here, 4-ch for CMYK streams),
 * so the face expands to RGBA itself. The EXIF orientation rides as a
 * fact; the pipeline bakes it on rotate(), never at decode (sharp parity:
 * metadata() reports the perceived axes, pixels stay stored-oriented). */
function jpegDecode(data) {
  const facts = jpegMetadata(data);
  const raw = jpegJs.decode(data, { useTArray: true });
  if (!raw || raw.width !== facts.width || raw.height !== facts.height) {
    throw new Error('jpeg: decoder disagreed with the container facts');
  }
  const size = raw.width * raw.height;
  const srcChannels = raw.data.length / size;
  if (!Number.isInteger(srcChannels) || srcChannels < 1 || srcChannels > 4) {
    throw new Error('jpeg: undecodable component interleave');
  }
  const rgba = new Uint8Array(size * 4);
  for (let px = 0; px < size; px += 1) {
    const at = px * srcChannels;
    if (srcChannels >= 3) {
      rgba[px * 4] = raw.data[at];
      rgba[px * 4 + 1] = raw.data[at + 1];
      rgba[px * 4 + 2] = raw.data[at + 2];
    } else {
      // grayscale: replicate the single component
      const value = raw.data[at];
      rgba[px * 4] = value;
      rgba[px * 4 + 1] = value;
      rgba[px * 4 + 2] = value;
    }
    rgba[px * 4 + 3] = 255;
  }
  return {
    data: rgba, width: raw.width, height: raw.height, channels: 4,
    depth: 8, space: facts.space,
    hasAlpha: false,
    orientation: facts.orientation,
  };
}

/** Build an EXIF APP1 body carrying just the Orientation tag. */
function exifApp1(orientation) {
  // 'Exif\0\0' + TIFF(II): header 8, IFD0 at 8: count=1, entry 12, next=0
  const tiff = new Uint8Array(8 + 2 + 12 + 4);
  tiff[0] = 0x49; tiff[1] = 0x49; // little-endian
  tiff[2] = 0x2A; tiff[3] = 0x00;
  tiff[4] = 0x08; tiff[5] = 0x00; tiff[6] = 0x00; tiff[7] = 0x00; // IFD0 at 8
  tiff[8] = 0x01; tiff[9] = 0x00; // one entry
  tiff[10] = 0x12; tiff[11] = 0x01; // tag 0x0112
  tiff[12] = 0x03; tiff[13] = 0x00; // SHORT
  tiff[14] = 0x01; tiff[15] = 0x00; tiff[16] = 0x00; tiff[17] = 0x00; // count 1
  tiff[18] = orientation & 0xFF; tiff[19] = 0x00; // value (inline, LE)
  tiff[22] = 0x00; tiff[23] = 0x00; tiff[24] = 0x00; tiff[25] = 0x00; // next IFD
  const head = Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // 'Exif\0\0'
  return bytes.concat([head, tiff]);
}

function segment(marker, body) {
  const out = new Uint8Array(4 + body.length);
  out[0] = 0xFF; out[1] = marker;
  out[2] = (body.length + 2) >> 8; out[3] = (body.length + 2) & 0xFF;
  out.set(body, 4);
  return out;
}

/** Encode RGBA pixels via jpeg-js, then splice the metadata segments the
 * pipeline asked for (EXIF orientation / Adobe cmyk tag) right after SOI. */
function jpegEncode(image, options = {}) {
  const { width, height, data } = image;
  // jpeg-js 0.4.4 takes quality as the POSITIONAL second argument (an
  // options object silently degrades the stream to flat blocks).
  const quality = typeof options.quality === 'number' ? options.quality : 80;
  const encoded = jpegJs.encode({ data, width, height }, quality).data;
  const extras = [];
  if (options.cmyk) {
    const adobe = new Uint8Array(12);
    adobe[0] = 0x41; adobe[1] = 0x64; adobe[2] = 0x6F; adobe[3] = 0x62; adobe[4] = 0x65; // 'Adobe'
    adobe[5] = 0x00; adobe[6] = 0x64; // version 100
    adobe[11] = 2; // transform: YCCK spelling
    extras.push(segment(0xEE, adobe));
  }
  if (options.orientation !== undefined) {
    extras.push(segment(0xE1, exifApp1(options.orientation)));
  }
  if (extras.length === 0) return encoded;
  return bytes.concat([encoded.subarray(0, 2), ...extras, encoded.subarray(2)]);
}

/** Minimal baseline TIFF: enough structure to be a real file (and to be
 * refused by the PNG/JPEG/GIF/WebP sniffers — the unsupported-format role
 * the family's rejection tests give it). */
function tiffEncode(image) {
  const { width, height } = image;
  const out = new Uint8Array(8 + 2 + 12 * 3 + 4 + 8);
  const view = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49; out[2] = 0x2A; out[3] = 0x00;
  view.setUint32(4, 8, true); // IFD at 8
  view.setUint16(8, 3, true); // entries: width, height, sample count
  view.setUint16(10, 256, true); view.setUint16(12, 4, true); view.setUint32(14, 1, true); view.setUint16(18, width, true); view.setUint16(20, 0, true);
  view.setUint16(22, 257, true); view.setUint16(24, 4, true); view.setUint32(26, 1, true); view.setUint16(30, height, true); view.setUint16(34, 0, true);
  view.setUint16(36, 277, true); view.setUint16(38, 3, true); view.setUint32(40, 1, true); view.setUint16(44, 3, true); view.setUint16(46, 0, true);
  view.setUint32(48, 0, true); // next IFD
  return out;
}

exports.jpegMetadata = jpegMetadata;
exports.jpegDecode = jpegDecode;
exports.jpegEncode = jpegEncode;
exports.tiffEncode = tiffEncode;
