// dsh:logging-exempt (host shim: no side effects to log)
/**
 * node:stream — the subset the vendored spine consumes: Readable.from
 * (iterable source), pipeline (serial pump, callback and promise forms),
 * PassThrough (a buffered identity segment). Streams here are the
 * one-shot-on-end shapes the node:zlib shim exposes — the pipeline drains
 * async iterators in order, which is exactly how the corpus composes
 * generation.js's rows -> zstd -> sink.
 */
class MiniStream {
  #listeners = new Map();
  #ended = false;
  #chunks = [];
  #waiters = [];
  #error = undefined;
  on(event, fn) { this.#push(event, fn); return this; }
  once(event, fn) {
    const wrapped = (value) => { this.#drop(event, wrapped); fn(value); };
    this.#push(event, wrapped);
    return this;
  }
  #push(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push(fn);
  }
  #drop(event, fn) {
    const list = this.#listeners.get(event) ?? [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }
  emit(event, value) {
    for (const fn of [...(this.#listeners.get(event) ?? [])]) fn(value);
    return this.#listeners.has(event);
  }
  push(chunk) { this.#chunks.push(chunk); this.#wake(); }
  end() { this.#ended = true; this.#wake(); }
  fail(error) { this.#error = error; this.#wake(); }
  #wake() { for (const w of this.#waiters.splice(0)) w(); }
  #next() {
    if (this.#chunks.length > 0) return Promise.resolve({ value: this.#chunks.shift(), done: false });
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => { this.#waiters.push(resolve); });
  }
  read() { return this.#chunks.length > 0 ? this.#chunks.shift() : null; }
  [Symbol.asyncIterator]() {
    return { next: () => this.#next() };
  }
  then(resolve, reject) {
    return this.#drain().then(resolve, reject);
  }
  async #drain() {
    const out = [];
    for (;;) {
      const { value, done } = await this.#next();
      if (done) return out;
      out.push(value);
    }
  }
  write(chunk) { this.push(chunk); return true; }
  destroy(error) { this.fail(error ?? new Error('destroyed')); }
  close() { this.end(); }
}
export class PassThrough extends MiniStream {}
export class Readable extends MiniStream {
  static from(iterable) {
    const stream = new Readable();
    (async () => {
      try {
        for await (const chunk of iterable) stream.push(chunk);
        stream.end();
      } catch (error) {
        stream.fail(error);
      }
    })();
    return stream;
  }
}
export async function pipeline(...parts) {
  const callback = typeof parts[parts.length - 1] === 'function' ? parts.pop() : undefined;
  const pumped = [];
  try {
    let source = parts[0];
    if (!(source && typeof source[Symbol.asyncIterator] === 'function')) {
      source = Readable.from(source);
    }
    for await (const chunk of source) {
      let value = chunk;
      for (const transform of parts.slice(1)) {
        if (typeof transform.write === 'function') {
          transform.write(value);
          value = await new Promise((resolve) => {
            const tick = () => {
              const out = transform.read();
              if (out !== null) resolve(out);
              else globalThis.setTimeout(tick, 0);
            };
            tick();
          });
        } else if (typeof transform === 'function') {
          value = transform(value);
        }
      }
      pumped.push(value);
    }
    for (const transform of parts.slice(1)) {
      if (typeof transform.end === 'function') transform.end();
    }
  } catch (error) {
    if (callback) return callback(error);
    throw error;
  }
  if (callback) callback(undefined, pumped);
  return pumped;
}
export default { Readable, PassThrough, pipeline };
