// gateway-shim.js — the panel suite's gateway.js for the plugin-manager
// write-leg battery: the fs legs carry an in-memory workspace, the http face
// serves TEST routes. The runtime spike host serves the same primitives over
// the C bridge; here they are a Map plus a route table, so the battery
// drives the REAL §4 install pipeline (tar bytes → digest → store → unpack
// → promote → receipt journal) end to end under node.
//
// Error shape: the contract's `{code: 'io'}` rejection — the gateway folds
// missing and failed reads into io on every host (contract/primitives.md).
export class GatewayError extends Error {
  constructor(code, primitive, message) {
    super(message ?? `gateway ${primitive} failed (${code})`);
    this.name = 'GatewayError';
    this.code = code;
    this.primitive = primitive;
  }
}

/** The in-memory workspace: `scope/path` → Uint8Array. Tests seed it
 * directly; the pipeline's writes land here too. */
export const workspace = new Map();

export const fsRead = async (scope, path) => {
  const bytes = workspace.get(`${scope}/${path}`);
  if (!bytes) throw new GatewayError('io', 'fsRead', `cannot read ${path}`);
  return { bytes, mtime: 0 };
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
