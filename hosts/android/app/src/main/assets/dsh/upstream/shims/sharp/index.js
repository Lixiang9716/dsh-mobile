// dsh:logging-exempt (shim layer: the pipeline face, no logging surface of its own)
/**
 * The sharp face of the DSH mobile shim — the pipeline object the vendored
 * attachment-local family drives (construct → metadata/raw/resize/rotate/
 * toColourspace → webp/jpeg/png/gif/tiff → toBuffer), backed by the vendored
 * pngjs/jpeg-js/fflate pins plus the hand-written GIF/WebP/SVG codecs beside
 * this file. NOT the upstream binary package: libvips cannot ride a QuickJS
 * closure (decision-matrix D-c), so this module reproduces the OBSERVABLE
 * contract those packages' tests assert — format facts, dimension/alpha/
 * depth semantics, the normalization and request-image ladders — with
 * documented deltas (lossy webp is a facts-preserving keyframe encoder;
 * SVG is a subset rasterizer with a bitmap font; metadata fidelity is
 * structural presence, not profile content).
 *
 * This file is CJS: on the dsh it loads through the userland cjs-loader
 * (both the bare-table path for createLazyRequire('sharp') and the
 * requireCjsPackage ESM bridge row), on node through plain require.
 */
const bytes = require('./bytes.js');
const png = require('./png-codec.js');
const jpeg = require('./jpeg-codec.js');
const gif = require('./gif-codec.js');
const webp = require('./webp-codec.js');
const svg = require('./svg-face.js');
const ops = require('./ops.js');

const SNIFF_LIMIT = 512;

/** Identify the encoded container; throws loud on unknown bytes (rule 5) —
 * the attachment layer wraps any throw into INVALID_IMAGE. */
function sniffFormat(data) {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
  if (data.length >= 3 && data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return 'jpeg';
  if (bytes.asciiAt(data, 0, 'GIF87a') || bytes.asciiAt(data, 0, 'GIF89a')) return 'gif';
  if (data.length >= 12 && bytes.asciiAt(data, 0, 'RIFF') && bytes.asciiAt(data, 8, 'WEBP')) return 'webp';
  if (data.length >= 4 && data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2A) return 'tiff';
  let head = '';
  for (let i = 0; i < Math.min(data.length, SNIFF_LIMIT); i += 1) {
    head += String.fromCharCode(data[i]);
    if (i > 64 && head.includes('<')) break;
  }
  if (head.includes('<svg') || head.startsWith('<?xml')) return 'svg';
  throw new Error('sharp shim: unsupported input bytes (not png/jpeg/webp/gif/tiff/svg)');
}

const DECODED_FORMAT = { png: png.pngMetadata, jpeg: jpeg.jpegMetadata, gif: gif.gifMetadata, webp: webp.webpMetadata, svg: svg.svgMetadata };
const PIXEL_DECODE = { png: png.pngDecode, jpeg: jpeg.jpegDecode, gif: gif.gifDecode, webp: webp.webpDecode, svg: svg.svgDecode };

/** JPEG orientation >= 5 transposes the stored raster. */
const ORIENTATION_TRANSPOSES = (o) => o !== undefined && o >= 5;

// The pixel ops (EXIF orientation, the area/bilinear resampler, depth and
// colourspace conversions, greyscale, alpha removal) live beside this file in
// ops.js — split when this file crossed the code-size budget.

/** The one Pipeline class sharp(input, options) hands out. */
class Pipeline {
  constructor(source, options = {}) {
    this._src = source; // {kind:'encoded'|'raw'|'create', ...}
    this._options = options;
    this._ops = [];
    this._format = undefined;
    this._quality = undefined;
    this._effort = undefined;
    this._withMetadata = false;
    this._orientationOut = undefined;
    this._iccProfileName = undefined;
    this._headerCache = undefined;
    this._pixelsCache = undefined;
  }

  clone() {
    const copy = new Pipeline(this._src, this._options);
    copy._ops = [...this._ops];
    copy._format = this._format;
    copy._quality = this._quality;
    copy._effort = this._effort;
    copy._withMetadata = this._withMetadata;
    copy._orientationOut = this._orientationOut;
    copy._iccProfileName = this._iccProfileName;
    return copy;
  }

  // ---- lazy decode faces ----

  header() {
    if (this._headerCache === undefined) {
      if (this._src.kind === 'encoded') {
        const decode = DECODED_FORMAT[this._src.format];
        if (decode === undefined) {
          throw new Error(`sharp shim: ${this._src.format} is not a decodable face (unsupported container)`);
        }
        this._headerCache = { format: this._src.format, ...decode(this._src.data) };
      } else if (this._src.kind === 'raw') {
        this._headerCache = {
          format: undefined, width: this._src.width, height: this._src.height,
          depth: 'uchar', space: 'srgb', hasAlpha: this._src.channels === 2 || this._src.channels === 4, pages: 1,
        };
      } else { // create
        this._headerCache = {
          format: undefined, width: this._src.width, height: this._src.height,
          depth: 'uchar', space: 'srgb', hasAlpha: this._src.channels === 4, pages: 1,
        };
      }
    }
    return this._headerCache;
  }

  /** Materialize pixels (decoded + ops applied), cached per pipeline. */
  pixels() {
    if (this._pixelsCache !== undefined) return this._pixelsCache;
    let image;
    if (this._src.kind === 'encoded') {
      image = PIXEL_DECODE[this._src.format](this._src.data);
    } else if (this._src.kind === 'raw') {
      const channels = this._src.channels;
      const size = this._src.width * this._src.height;
      const data = new Uint8Array(size * 4);
      for (let px = 0; px < size; px += 1) {
        data[px * 4] = this._src.data[px * channels] ?? 0;
        data[px * 4 + 1] = channels >= 2 ? (this._src.data[px * channels + 1] ?? 0) : data[px * 4];
        data[px * 4 + 2] = channels >= 3 ? (this._src.data[px * channels + 2] ?? 0) : data[px * 4];
        data[px * 4 + 3] = channels === 4 ? this._src.data[px * channels + 3] : 255;
      }
      image = { data, width: this._src.width, height: this._src.height, depth: 8, space: 'srgb', hasAlpha: channels === 4, orientation: undefined };
    } else { // create
      const channels = this._src.channels;
      const bg = this._src.background;
      const size = this._src.width * this._src.height;
      const data = new Uint8Array(size * 4);
      for (let px = 0; px < size; px += 1) {
        data[px * 4] = bg.r;
        data[px * 4 + 1] = bg.g;
        data[px * 4 + 2] = bg.b;
        data[px * 4 + 3] = channels === 4 ? Math.round((bg.alpha === undefined ? 1 : bg.alpha) * 255) : 255;
      }
      image = { data, width: this._src.width, height: this._src.height, depth: 8, space: 'srgb', hasAlpha: channels === 4, orientation: undefined };
    }
    // EXIF orientation reported by metadata() is NOT baked until rotate()
    // (sharp parity: perceived axes are reported, pixels stay stored).
    for (const op of this._ops) image = this._applyOp(image, op);
    this._pixelsCache = image;
    return image;
  }

  _applyOp(image, op) {
    if (op.op === 'rotate') {
      const orientation = image.orientation;
      if (op.angle === undefined && orientation !== undefined) {
        return ops.applyOrientation(image, orientation);
      }
      return image;
    }
    if (op.op === 'resize') {
      const src = image;
      let targetW = op.width;
      let targetH = op.height;
      if (targetW === undefined && targetH === undefined) return image;
      let scale;
      if (targetW === undefined || targetH === undefined) {
        scale = targetW !== undefined ? targetW / src.width : targetH / src.height;
        if (op.withoutEnlargement && scale > 1) return image;
        if (targetW === undefined) targetW = Math.max(1, Math.round(src.width * scale));
        if (targetH === undefined) targetH = Math.max(1, Math.round(src.height * scale));
      } else {
        // both axes: fit inside (the family's only multi-axis spelling)
        scale = Math.min(targetW / src.width, targetH / src.height);
        if (op.withoutEnlargement && scale > 1) scale = 1;
        targetW = Math.max(1, Math.round(src.width * scale));
        targetH = Math.max(1, Math.round(src.height * scale));
      }
      return ops.resizePixels(src, targetW, targetH);
    }
    if (op.op === 'colourspace') {
      if (op.tag === 'srgb' && image.space === 'rgb16') return ops.depthTo8(image);
      if (op.tag === 'srgb') return { ...image, space: 'srgb' };
      if (op.tag === 'rgb16') return ops.depthTo16(image);
      if (op.tag === 'cmyk') return { ...image, space: 'cmyk' };
      throw new Error(`sharp shim: colourspace ${op.tag} is not a served face`);
    }
    if (op.op === 'removeAlpha') return ops.dropAlpha(image);
    if (op.op === 'greyscale') return ops.greyscalePixels(image);
    throw new Error(`sharp shim: unknown op ${op.op}`);
  }

  // ---- the sharp chainable face ----

  async metadata() {
    const facts = this.header();
    // STORED dimensions + the orientation fact: sharp's metadata() does not
    // pre-apply EXIF orientation — callers (image.ts's perceived-axes math)
    // transpose themselves from the reported orientation.
    const orientation = facts.orientation;
    return Promise.resolve({
      format: facts.format,
      width: facts.width,
      height: facts.height,
      pages: facts.pages ?? 1,
      depth: facts.depth,
      space: facts.space,
      hasAlpha: facts.hasAlpha,
      ...(orientation !== undefined ? { orientation } : {}),
      ...facts.exif ? { exif: Buffer.alloc(4) } : {},
      ...(facts.icc !== undefined || facts.exif ? { hasProfile: facts.icc !== undefined } : {}),
      ...(facts.comments !== undefined && facts.comments.length > 0 ? { comments: facts.comments } : {}),
    });
  }

  rotate(angle) {
    this._ops.push({ op: 'rotate', angle });
    return this;
  }

  resize(options) {
    this._ops.push({
      op: 'resize',
      width: options.width,
      height: options.height,
      withoutEnlargement: options.withoutEnlargement === true,
      fit: options.fit,
    });
    return this;
  }

  toColourspace(tag) {
    this._ops.push({ op: 'colourspace', tag });
    return this;
  }

  removeAlpha() {
    this._ops.push({ op: 'removeAlpha' });
    return this;
  }

  greyscale() {
    this._ops.push({ op: 'greyscale' });
    return this;
  }

  withMetadata(options) {
    this._withMetadata = true;
    if (options && options.orientation !== undefined) this._orientationOut = options.orientation;
    return this;
  }

  withIccProfile(name) {
    this._iccProfileName = name;
    return this;
  }

  png(options) {
    this._format = 'png';
    if (options && options.quality !== undefined) this._quality = options.quality;
    return this;
  }

  jpeg(options) {
    this._format = 'jpeg';
    if (options && options.quality !== undefined) this._quality = options.quality;
    return this;
  }

  webp(options) {
    this._format = 'webp';
    if (options && options.quality !== undefined) this._quality = options.quality;
    if (options && options.effort !== undefined) this._effort = options.effort;
    return this;
  }

  gif(options) {
    this._format = 'gif';
    if (options && options.quality !== undefined) this._quality = options.quality;
    return this;
  }

  tiff(options) {
    this._format = 'tiff';
    if (options && options.quality !== undefined) this._quality = options.quality;
    return this;
  }

  toFormat(format, options) {
    const normalized = String(format).toLowerCase();
    if (normalized === 'jpg') return this.jpeg(options);
    return this[normalized](options);
  }

  raw() {
    return {
      toBuffer: async () => {
        const image = this.pixels();
        const channels = image.hasAlpha ? 4 : 3;
        const size = image.width * image.height * channels;
        const out = new (image.depth === 16 ? Uint16Array : Uint8Array)(size);
        for (let px = 0; px < image.width * image.height; px += 1) {
          for (let c = 0; c < channels; c += 1) out[px * channels + c] = image.data[px * 4 + c];
        }
        // Byte-view copy: the Buffer global's from() is a (input, encoding)
        // face here — the byte copy keeps the return shape Buffer-like.
        return Promise.resolve(Buffer.from(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)));
      },
    };
  }

  async stats() {
    const image = this.pixels();
    const channels = image.hasAlpha ? 4 : 3;
    const mins = new Array(channels).fill(Infinity);
    const maxs = new Array(channels).fill(-Infinity);
    const sums = new Array(channels).fill(0);
    for (let px = 0; px < image.width * image.height; px += 1) {
      for (let c = 0; c < channels; c += 1) {
        const v = image.data[px * 4 + c];
        if (v < mins[c]) mins[c] = v;
        if (v > maxs[c]) maxs[c] = v;
        sums[c] += v;
      }
    }
    return Promise.resolve({
      channels: mins.map((min, c) => ({ min, max: maxs[c], sum: sums[c], squaresSum: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 })),
      isOpaque: !image.hasAlpha,
      entropy: 0,
      sharpness: 0,
      dominant: { r: 0, g: 0, b: 0 },
    });
  }

  _encodeBuffer(image) {
    const format = this._format
      ?? (this._src.kind === 'encoded' && this._src.format !== 'svg' ? this._src.format : 'png');
    const alpha = image.hasAlpha;
    if (format === 'png') {
      return png.pngEncode(
        { width: image.width, height: image.height, channels: alpha ? 4 : 3, depth: image.depth, data: image.data },
        {
          iccProfileName: this._iccProfileName,
          softwareText: this._withMetadata,
        },
      );
    }
    if (format === 'jpeg' || format === 'jpg') {
      const eight = ops.depthTo8(image);
      return jpeg.jpegEncode(
        { width: eight.width, height: eight.height, data: eight.data },
        {
          quality: this._quality ?? 80,
          orientation: this._orientationOut,
          cmyk: image.space === 'cmyk',
        },
      );
    }
    if (format === 'webp') {
      const eight = ops.depthTo8(image);
      return webp.webpEncode(
        { width: eight.width, height: eight.height, data: eight.data },
        { quality: this._quality ?? 80, effort: this._effort },
      );
    }
    if (format === 'gif') {
      const eight = ops.depthTo8(image);
      return gif.gifEncode({ width: eight.width, height: eight.height, data: eight.data });
    }
    if (format === 'tiff') {
      return jpeg.tiffEncode(image);
    }
    throw new Error(`sharp shim: output format ${format} is not a served face`);
  }

  async toBuffer(options = {}) {
    const image = this.pixels();
    const encoded = this._encodeBuffer(image);
    if (options.resolveWithObject) {
      return {
        data: Buffer.from(encoded),
        info: {
          width: image.width,
          height: image.height,
          size: encoded.length,
          format: this._format ?? 'png',
        },
      };
    }
    return Buffer.from(encoded);
  }
}

/** The sharp callable: input dispatch per the face's three constructor
 * spellings (encoded bytes / raw pixels / created canvas). */
function sharp(input, options = {}) {
  let source;
  if (input === undefined || input === null) {
    source = { kind: 'raw', data: new Uint8Array(0), width: 0, height: 0, channels: 4 };
  } else if (typeof input === 'object' && !Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    if (input.create !== undefined) {
      const create = input.create;
      source = {
        kind: 'create',
        width: create.width,
        height: create.height,
        channels: create.channels ?? 4,
        background: create.background ?? { r: 0, g: 0, b: 0 },
      };
    } else if (input.raw !== undefined) {
      source = {
        kind: 'raw',
        data: options.unsafe !== true ? new Uint8Array(input.raw.data) : input.raw.data,
        width: input.raw.width,
        height: input.raw.height,
        channels: input.raw.channels ?? 4,
      };
    } else {
      throw new Error('sharp shim: object input needs create or raw');
    }
  } else {
    const data = input instanceof Uint8Array && !Buffer.isBuffer(input) ? Buffer.from(input) : input;
    if (options.raw !== undefined) {
      // the sharp(raw-pixels, { raw: { width, height, channels } }) spelling
      source = {
        kind: 'raw',
        data,
        width: options.raw.width,
        height: options.raw.height,
        channels: options.raw.channels ?? 4,
      };
    } else {
      source = { kind: 'encoded', format: sniffFormat(data), data };
    }
  }
  return new Pipeline(source, options);
}

// Names the vendored closure touches on the namespace object (type-only
// imports erase at transpile; this is the runtime remainder).
sharp.format = { input: { jpeg: {}, png: {}, webp: {}, gif: {}, tiff: {}, svg: {} }, output: { jpeg: {}, png: {}, webp: {}, gif: {}, tiff: {} } };
sharp.versions = { vips: 'dsh-shim-purejs' };
sharp.default = sharp;

module.exports = sharp;
