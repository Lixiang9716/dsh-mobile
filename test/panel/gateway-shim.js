// gateway-shim.js — the panel suite's gateway.js: the wasmRun leg EXECUTES,
// the fs legs carry an in-memory workspace.
//
// The wasmRun shim is a byte-faithful mirror of the C runner the device
// serves (runtime/dsh/host/dsh_wasm.c): the caller's input rides the LAST
// 4096 bytes of the module's own memory as a NUL-terminated string, the
// export `run(ptr, len)` receives (pointer, length), dsh.emit(ptr, len)
// appends to the collected output, and the export's i32 return is the
// result. Node's own WebAssembly plays the interpreter — the vendored wasm3
// plays it on the device — so a program that behaves differently under this
// shim than under dsh_wasm.c is a broken module, and the suite catches it
// here rather than on a seat.
//
// The fs face is the contract's shape over one Map: fsRead answers
// `{bytes, mtime}` and refuses a missing path with the EXACT rejection the
// C hosts answer (`io` + "cannot read <path>") — the message the shell
// executor's not-found branch matches on.
import { createHash } from 'node:crypto';

export class GatewayError extends Error {
  constructor(code, primitive, message) {
    super(message ?? `gateway ${primitive} failed (${code})`);
    this.name = 'GatewayError';
    this.code = code;
    this.primitive = primitive;
  }
}

/** The in-memory workspace: (scope, path) → Uint8Array. Tests seed it
 * directly; the starter writes land here too. */
export const workspace = new Map();

export const fsRead = async (scope, path) => {
  const bytes = workspace.get(`${scope}/${path}`);
  if (!bytes) throw new GatewayError('io', 'fsRead', `cannot read ${path}`);
  return { bytes, mtime: new Date(0).toISOString() };
};

export const fsWrite = async (scope, path, bytes, opts = {}) => {
  const key = `${scope}/${path}`;
  // {append: true} is the receipts journal's primitive (append-only lines —
  // the §4 journal is never rewritten).
  if (opts.append === true && workspace.has(key)) {
    const prev = workspace.get(key);
    const merged = new Uint8Array(prev.length + bytes.length);
    merged.set(prev, 0);
    merged.set(bytes, prev.length);
    workspace.set(key, merged);
    return { written: bytes.length };
  }
  workspace.set(key, bytes);
  return { written: bytes.length };
};

export const fsRemove = async (scope, path, opts = {}) => {
  const prefix = `${scope}/${path}/`;
  let removed = 0;
  for (const key of [...workspace.keys()]) {
    if (key === `${scope}/${path}` || (opts.recursive === true && key.startsWith(prefix))) {
      workspace.delete(key);
      removed++;
    }
  }
  if (removed === 0) throw new GatewayError('io', 'fsRemove', `cannot read ${path}`);
  return { removed };
};

/** The http face for the install legs: routes the TEST installs per url —
 * the same `{status, body: AsyncIterable<Uint8Array>}` response shape the
 * C host serves (install-fetch.js drains the body as an async iterable). */
const httpRoutes = new Map(); // url → {status, bodyBytes}

export const __httpRoute = (url, bodyBytes, status = 200) => {
  httpRoutes.set(url, { status, bodyBytes });
};

export const __httpReset = () => httpRoutes.clear();

/** Test-side read of one stored file (the full `scope/path` key). */
export const __dump = (key) => workspace.get(key);

export const httpFetch = async (url, opts = {}) => {
  const route = httpRoutes.get(url);
  if (route === undefined) throw new GatewayError('network', 'httpFetch', `no route: ${url}`);
  return {
    status: route.status,
    body: (async function* served() { yield route.bodyBytes; })(),
  };
};

export const wasmRun = async (scope, path, func, input = '') => {
  const bytes = workspace.get(`${scope}/${path}`);
  if (!bytes) throw new GatewayError('io', 'wasmRun', `cannot read ${path}`);
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(bytes),
    { dsh: { emit: (ptr, len) => {
      const mem = new Uint8Array(instance.exports.memory.buffer);
      out.push(mem.slice(ptr, ptr + len));
    } } },
  );
  const out = [];
  const mem = new Uint8Array(instance.exports.memory.buffer);
  const RESERVE = 4096; // dsh_wasm.c's DSH_WASM_INPUT_RESERVE
  if (mem.length <= RESERVE) throw new GatewayError('io', 'wasmRun', 'module memory too small');
  const inPtr = mem.length - RESERVE;
  const text = new TextEncoder().encode(input);
  if (text.length > RESERVE - 1) throw new GatewayError('io', 'wasmRun', 'input too large');
  mem.set(text, inPtr);
  mem[inPtr + text.length] = 0;
  const run = instance.exports[func];
  if (typeof run !== 'function') {
    throw new GatewayError('io', 'wasmRun', `no export "${func}"`);
  }
  const result = run(inPtr, text.length);
  const merged = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of out) { merged.set(chunk, at); at += chunk.length; }
  return { result, output: new TextDecoder().decode(merged) };
};

/** The sha256 the byte pins are stated in (programs.js PINS). */
export const sha256Hex = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
