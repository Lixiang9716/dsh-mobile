// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/web-streams.js — the WHATWG streams/response globals the upstream
 * suite's web-adjacent faces use as BARE GLOBALS (quickjs defines none):
 *   - ReadableStream — the enqueue/pull controller face; async-iterable
 *     (parseSse's decoder rides it), getReader(), pipeThrough/pipeTo.
 *   - TransformStream — the writable→transform→readable pipe; a throwing
 *     transform errors the readable (the image-gzip member check throws
 *     mid-pipe BY DESIGN), close runs the flush.
 *   - DecompressionStream("gzip") — streaming decode over the vendored
 *     fflate Gunzip (the node:zlib bridge's twin; same pinned 0.8.2 tree).
 *   - Response — from bytes or any readable face; .body, .arrayBuffer(),
 *     .text() (the image loader pipes Response.body).
 * Deliberately NOT implemented: HTTP semantics (status/header plumbing),
 * CompressionStream (nothing compresses through a global), Blob/FormData.
 * Installed by shims/globals.js only when the host has not bound its own.
 */
import { Gunzip } from '/vendor/npm/fflate@0.8.2/esm/browser.js';

/** Shared queue machinery for every readable side here: reads resolve with
 * {value, done}; a later enqueue/close/error wakes pending reads with a fresh
 * evaluation (never a bare undefined — quickjs enforces the iterator shape). */
class ReadableQueue {
  #queue = [];
  #done = false;
  #error = undefined;
  #waiters = [];

  enqueue(chunk) {
    if (this.#done || this.#error !== undefined) return;
    this.#queue.push(chunk);
    this.#wake();
  }

  close() {
    if (this.#done) return;
    this.#done = true;
    this.#wake();
  }

  error(cause) {
    if (this.#done || this.#error !== undefined) return;
    this.#error = cause;
    this.#wake();
  }

  #wake() { for (const w of this.#waiters.splice(0)) w(); }

  next() {
    if (this.#queue.length > 0) return Promise.resolve({ value: this.#queue.shift(), done: false });
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.#waiters.push(() => {
        try { resolve(this.next()); } catch (error) { reject(error); }
      });
    });
  }
}

/** The pipeThrough face: pump the source into a {writable, readable}
 * transform, closing the destination on completion. WHATWG error propagation:
 * a source error ABORTS the destination writable (which errors the
 * transform's readable with the cause) — a clean cancel would mask the
 * failure (measured 2026-09-28, R3-H: image-gzip refusal tests resolved). */
const pipeThroughFace = (consume, transform) => {
  if (transform?.writable === undefined || transform?.readable === undefined) {
    throw new TypeError('pipeThrough: a {writable, readable} transform is required');
  }
  (async () => {
    for (;;) {
      const { value, done } = await consume();
      if (done) {
        transform.writable.close?.();
        return;
      }
      transform.writable.enqueue?.(value);
    }
  })().catch((cause) => {
    try { transform.writable.abort?.(cause); } catch { /* already closed */ }
    try { transform.readable.cancel?.(cause); } catch { /* already closed */ }
  });
  return transform.readable;
};

/** The pipeTo face: pump the source into a writable sink, closing it on
 * completion (every chunk awaited — backpressure over the sink face). */
const pipeToFace = (consume, writable) => (async () => {
  for (;;) {
    const { value, done } = await consume();
    if (done) {
      writable.close?.();
      return;
    }
    await writable.write?.(value);
  }
})();

/** A minimal readable object over a queue: async-iterable, getReader(),
 * pipeThrough/pipeTo over this file's transform faces. `armPull` re-drives
 * the user pull around EVERY consumption step — the constructor's one
 * start-pull covers only the first chunk, so a pull-per-chunk source (the
 * SSE spec's byte-at-a-time ReadableStream) starved after chunk one and the
 * await deadlocked (measured 2026-09-28, R3-H). #pullBusy keeps this
 * re-entrant-safe (one pull in flight). */
const readableFromQueue = (queue, armPull) => {
  const consume = () => {
    armPull?.();
    return queue.next();
  };
  return {
    [Symbol.asyncIterator]() {
      return {
        next: consume,
        return: (value) => Promise.resolve({ value, done: true }),
        throw: (error) => Promise.reject(error),
      };
    },
    getReader: () => ({
      read: consume,
      cancel: () => queue.close(),
      releaseLock: () => {},
    }),
    pipeThrough: (transform) => pipeThroughFace(consume, transform),
    pipeTo: (writable) => pipeToFace(consume, writable),
    cancel: () => queue.close(),
  };
};

const isReadableFace = (value) => value !== null && typeof value === 'object'
  && (typeof value.getReader === 'function' || typeof value[Symbol.asyncIterator] === 'function');

/** A WritableStreamDefaultWriter over one of this file's sink faces — the
 * acp ndJsonStream drives `writable.getWriter()` (write + releaseLock),
 * while the image loader drives `writable.enqueue` directly; both spellings
 * land in the SAME sink, so the face is additive, not a second channel. */
const withWriter = (writable) => ({
  ...writable,
  getWriter: () => ({
    write: (chunk) => Promise.resolve((writable.enqueue ?? writable.write)?.(chunk)),
    close: () => Promise.resolve(writable.close?.()),
    abort: (reason) => Promise.resolve(writable.abort?.(reason)),
    releaseLock: () => {},
    get closed() { return Promise.resolve(); },
    get ready() { return Promise.resolve(); },
    get desiredSize() { return 1; },
  }),
});

export class ReadableStream {
  #queue = new ReadableQueue();
  #pullImpl;
  #cancelImpl;
  #pullBusy = false;
  #face;

  constructor(underlying = {}) {
    if (underlying === null || typeof underlying !== 'object') {
      throw new TypeError('ReadableStream: the underlying source must be an object');
    }
    this.#pullImpl = typeof underlying.pull === 'function' ? underlying.pull : null;
    this.#cancelImpl = typeof underlying.cancel === 'function' ? underlying.cancel : null;
    const controller = {
      enqueue: (chunk) => this.#queue.enqueue(chunk),
      close: () => this.#queue.close(),
      error: (cause) => this.#queue.error(cause),
      get desiredSize() { return 1; },
    };
    let startResult;
    try {
      startResult = typeof underlying.start === 'function' ? underlying.start(controller) : undefined;
    } catch (error) {
      this.#queue.error(error);
    }
    Promise.resolve(startResult)
      .then(() => this.#maybePull(controller))
      .catch((error) => this.#queue.error(error));
    this.#face = readableFromQueue(this.#queue, () => this.#armPull());
  }

  /** Drive the user pull once per read while open (the queue carries the
   * chunks; controller.enqueue wakes any pending read). */
  #maybePull(controller) {
    if (this.#pullBusy || this.#pullImpl === null) return;
    this.#pullBusy = true;
    Promise.resolve()
      .then(() => this.#pullImpl(controller))
      .catch((error) => this.#queue.error(error))
      .finally(() => { this.#pullBusy = false; });
  }

  #armPull() {
    if (this.#pullImpl === null) return;
    this.#maybePull({
      enqueue: (chunk) => this.#queue.enqueue(chunk),
      close: () => this.#queue.close(),
      error: (cause) => this.#queue.error(cause),
    });
  }

  getReader() {
    const reader = this.#face.getReader();
    const read = reader.read.bind(reader);
    return {
      read: () => {
        const outcome = read();
        this.#armPull();
        return outcome;
      },
      cancel: (reason) => Promise.resolve(this.#cancelImpl?.(reason)),
      releaseLock: () => reader.releaseLock(),
    };
  }

  cancel(reason) {
    this.#queue.close();
    return Promise.resolve(this.#cancelImpl?.(reason));
  }

  pipeThrough(transform) { return this.#face.pipeThrough(transform); }
  pipeTo(writable) { return this.#face.pipeTo(writable); }
  [Symbol.asyncIterator]() { return this.#face[Symbol.asyncIterator](); }
}

/** The writable side of a TransformStream: enqueue routes through the user
 * transform into the readable's queue; close runs the flush. */
export class WritableStream {
  #sink;
  constructor(sink = {}) {
    this.#sink = sink;
  }
  getWriter() {
    const sink = this.#sink;
    return {
      write: (chunk) => Promise.resolve(sink.write?.(chunk)),
      close: () => Promise.resolve(sink.close?.()),
      abort: (reason) => Promise.resolve(sink.abort?.(reason)),
      releaseLock: () => {},
      get closed() { return Promise.resolve(); },
      get ready() { return Promise.resolve(); },
      get desiredSize() { return 1; },
    };
  }
}

export class TransformStream {
  readable;
  writable;
  constructor(transformer = {}) {
    if (transformer === null || typeof transformer !== 'object') {
      throw new TypeError('TransformStream: the transformer must be an object');
    }
    const { start, transform, flush } = transformer;
    const queue = new ReadableQueue();
    const controller = {
      enqueue: (chunk) => queue.enqueue(chunk),
      close: () => queue.close(),
      error: (cause) => queue.error(cause),
      get desiredSize() { return 1; },
    };
    // The start hook runs first (eventsource-parser's stream builds its
    // line parser there; transform depends on that closure state).
    let startResult;
    try {
      startResult = typeof start === 'function' ? start(controller) : undefined;
    } catch (error) {
      queue.error(error);
    }
    Promise.resolve(startResult).catch((error) => queue.error(error));
    this.readable = readableFromQueue(queue);
    this.writable = withWriter({
      enqueue: (chunk) => {
        try {
          if (typeof transform === 'function') transform(chunk, controller);
          else controller.enqueue(chunk);
        } catch (error) {
          queue.error(error);
          throw error;
        }
      },
      close: () => Promise.resolve()
        .then(() => flush?.(controller))
        .then(() => queue.close())
        .catch((error) => queue.error(error)),
      abort: (reason) => queue.error(reason),
    });
  }
}

/** DecompressionStream("gzip") — streaming decode over the vendored fflate
 * Gunzip. "deflate" names fflate's raw Inflate per the WHATWG label table;
 * anything else fails loud (rule 5). */
export class DecompressionStream {
  readable;
  writable;
  constructor(format) {
    if (format !== 'gzip' && format !== 'deflate') {
      throw new Error(`DecompressionStream: format '${String(format)}' — supported: gzip, deflate`);
    }
    const queue = new ReadableQueue();
    // fflate's streaming callback carries the member-end marker (final=true)
    // — the completeness signal node's zlib raises as "unexpected end of
    // file" on a truncated member. Synchronous throws (invalid gzip data)
    // and a missing marker at close both land in the READABLE as an error,
    // so a corrupt body rejects downstream instead of resolving as an empty
    // archive (measured 2026-09-28, R3-H: the webworker image-gzip refusal
    // tests resolved on garbage input).
    let sawFinal = false;
    const dec = new Gunzip((chunk, final) => {
      queue.enqueue(chunk);
      if (final === true) sawFinal = true;
    });
    let closed = false;
    this.readable = readableFromQueue(queue);
    this.writable = withWriter({
      enqueue: (chunk) => {
        if (closed) throw new Error('DecompressionStream: write after close');
        try {
          dec.push(chunk);
        } catch (cause) {
          queue.error(cause);
          throw cause;
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        try {
          dec.push(new Uint8Array(0), true);
        } catch (cause) {
          queue.error(cause);
          throw cause;
        }
        if (!sawFinal) {
          queue.error(new Error('DecompressionStream: truncated gzip member (stream ended before the deflate footer)'));
          return;
        }
        queue.close();
      },
      abort: (reason) => queue.error(reason ?? new Error('DecompressionStream: aborted')),
    });
  }
}

/** The Response stream-body face: an already-native ReadableStream passes
 * through; any other readable face wraps in a native one-chunk-per-pull
 * stream (a fresh reader per pull, like the direct spelling). */
const streamBodyFace = (stream) => {
  if (stream instanceof ReadableStream) return stream;
  return new ReadableStream({
    pull: (controller) => (async () => {
      for (;;) {
        const { value, done } = await stream.getReader().read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
        return;
      }
    })(),
  });
};

/** Response — the body face the image loader drives: constructed from bytes
 * or any readable face; .body (a ReadableStream), .arrayBuffer(), .text(). */
export class Response {
  #source;
  // init face (status/headers) — the search providers build stub Responses
  // with { status, headers } and read response.ok/.status/.json()
  // (measured 2026-09-27: web-search-deepseek/exa/perplexity settings suites).
  #status = 200;
  #headers = new Map();
  constructor(body, init) {
    this.#status = typeof init?.status === 'number' ? init.status : 200;
    this.#headers = new Map(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (body instanceof Response) {
      this.#source = body.#source;
      return;
    }
    if (body === null || body === undefined) {
      this.#source = { kind: 'bytes', bytes: new Uint8Array(0) };
    } else if (typeof body === 'string') {
      this.#source = { kind: 'bytes', bytes: new globalThis.TextEncoder().encode(body) };
    } else if (body instanceof Uint8Array) {
      this.#source = { kind: 'bytes', bytes: body };
    } else if (body instanceof ArrayBuffer) {
      this.#source = { kind: 'bytes', bytes: new Uint8Array(body) };
    } else if (isReadableFace(body)) {
      this.#source = { kind: 'stream', stream: body };
    } else {
      throw new TypeError(`Response: unsupported body ${typeof body}`);
    }
  }

  get body() {
    if (this.#source.kind === 'stream') return streamBodyFace(this.#source.stream);
    const bytes = this.#source.bytes;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  arrayBuffer() {
    if (this.#source.kind === 'bytes') {
      const bytes = this.#source.bytes;
      return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    return (async () => {
      const reader = this.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out.buffer;
    })();
  }

  text() {
    return this.arrayBuffer().then((buffer) => new globalThis.TextDecoder().decode(new Uint8Array(buffer)));
  }

  get ok() { return this.#status >= 200 && this.#status < 300; }
  get status() { return this.#status; }
  get headers() {
    const map = this.#headers;
    return {
      get: (name) => map.get(String(name).toLowerCase()),
      has: (name) => map.has(String(name).toLowerCase()),
    };
  }
  json() {
    return this.text().then((text) => JSON.parse(text));
  }
}

export default { ReadableStream, WritableStream, TransformStream, DecompressionStream, Response };

/** TextDecoderStream/TextEncoderStream — the codec pipes (parseSse decodes
 * its byte stream through TextDecoderStream). Labels ride the harness's
 * global TextDecoder/TextEncoder (utf-8; any other label fails there). */
export class TextDecoderStream {
  readable;
  writable;
  constructor(label = 'utf-8', options = {}) {
    const decoder = new globalThis.TextDecoder(label, options);
    const queue = new ReadableQueue();
    let carry = new Uint8Array(0);
    const decode = (chunk) => {
      const merged = new Uint8Array(carry.length + chunk.length);
      merged.set(carry, 0);
      merged.set(chunk, carry.length);
      return decoder.decode(merged, { stream: true });
    };
    this.readable = readableFromQueue(queue);
    this.writable = withWriter({
      enqueue: (chunk) => {
        const text = decode(chunk);
        if (text.length > 0) queue.enqueue(text);
      },
      close: () => {
        const tail = decoder.decode();
        if (tail.length > 0) queue.enqueue(tail);
        queue.close();
      },
      abort: (reason) => queue.error(reason),
    });
  }
}

export class TextEncoderStream {
  readable;
  writable;
  constructor() {
    const encoder = new globalThis.TextEncoder();
    const queue = new ReadableQueue();
    this.readable = readableFromQueue(queue);
    this.writable = withWriter({
      enqueue: (chunk) => {
        const bytes = encoder.encode(String(chunk));
        if (bytes.length > 0) queue.enqueue(bytes);
      },
      close: () => queue.close(),
      abort: (reason) => queue.error(reason),
    });
  }
}
