// dsh:logging-exempt (host shim: no side effects to log)
/**
 * node:string_decoder — the UTF-8 decoder the sdk protocol faces drive
 * (`new StringDecoder("utf8")`, `.write(bytes)` per chunk, `.end()` at EOF).
 * Its whole point is the BYTE-BOUNDARY buffer: a multi-byte sequence split
 * across chunk writes is held back until its tail arrives, so naive
 * per-chunk decoding never emits U+FFFD for a merely-split character.
 * Registered under `node:string_decoder` by shims/runtime-modules.js (the
 * host SHIMS table has no row; the runtime-module seam is checked first).
 * utf-8 only — any other label fails loud (rule 5), the same wall util.js's
 * TextDecoder has.
 */
import { decodeUtf8 } from 'upstream/shims/buffer.js';

/** Decode `bytes` fully; return [text, tailLength] where tailLength is the
 * length of the trailing (possibly truncated) multi-byte sequence. */
const decodeWithTail = (bytes) => {
  const length = bytes.length;
  if (length === 0) return ['', 0];
  // Sequence length from the lead byte (bit patterns per RFC 3629).
  const sequenceLength = (lead) => {
    if ((lead & 0x80) === 0) return 1;
    if ((lead & 0xe0) === 0xc0) return 2;
    if ((lead & 0xf0) === 0xe0) return 3;
    if ((lead & 0xf8) === 0xf0) return 4;
    return 1; // stray continuation / invalid lead: decodeUtf8's U+FFFD face
  };
  let tail = 0;
  // Walk back over continuation bytes; a truncated sequence at the end (up
  // to its declared length) is held for the next write.
  let at = length - 1;
  while (at >= 0 && (bytes[at] & 0xc0) === 0x80) at -= 1;
  if (at >= 0) {
    const declared = sequenceLength(bytes[at]);
    if (declared > 1 && length - at < declared) tail = length - at;
  }
  const cut = length - tail;
  return [cut > 0 ? decodeUtf8(bytes.subarray(0, cut)) : '', tail];
};

export class StringDecoder {
  #encoding;
  #tail = new Uint8Array(0);
  #ended = false;

  constructor(encoding = 'utf8') {
    const label = typeof encoding === 'string' ? encoding.toLowerCase() : 'utf8';
    if (label !== 'utf8' && label !== 'utf-8') {
      throw new Error(`node:string_decoder: encoding '${String(encoding)}' — supported: utf8`);
    }
    this.#encoding = label;
  }

  get encoding() { return this.#encoding; }

  /** Decode one chunk; a trailing split sequence is buffered. Strings pass
   * through (node: already-decoded text). */
  write(bytes) {
    if (this.#ended) {
      // node re-arms after end(); the tail buffer is the only carried state.
      this.#ended = false;
      this.#tail = new Uint8Array(0);
    }
    if (typeof bytes === 'string') return bytes;
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(`StringDecoder.write: Buffer/Uint8Array/string expected, got ${typeof bytes}`);
    }
    let pending = bytes;
    if (this.#tail.length > 0) {
      pending = new Uint8Array(this.#tail.length + bytes.length);
      pending.set(this.#tail, 0);
      pending.set(bytes, this.#tail.length);
      this.#tail = new Uint8Array(0);
    }
    const [text, tailLength] = decodeWithTail(pending);
    if (tailLength > 0) this.#tail = pending.slice(pending.length - tailLength);
    return text;
  }

  /** Flush: an incomplete trailing sequence decodes as replacement
   * characters (node's end()); after this the decoder is drained. */
  end() {
    this.#ended = true;
    if (this.#tail.length === 0) return '';
    const remainder = decodeUtf8(this.#tail);
    this.#tail = new Uint8Array(0);
    return remainder;
  }
}

export default StringDecoder;
