// dsh:logging-exempt (state plumbing over vendored shapes; logging stays in the callers)
/**
 * workspace-registry.js — the WORKSPACE dsh.plugins/1 registry face shared
 * by the `plugin_manager` tool (system-plugins/dsh-plugin-manager-tools,
 * #346 item 3) and the 插件 inventory's workspace-tier provider
 * (scenario/write-surface-options.js). One home for where the file lives,
 * how it is read, and how its rows mutate.
 *
 * WHERE THE FILE LIVES (#346): the workspace is the profile container
 * (`runtime.config containerRoot`, pinned as __dshProfileCwd), which on a
 * real device seat sits BELOW the reserved app scope's root (`fsScopeRoot`,
 * pinned as __dshProfileScopeRoot) — Android: `<filesDir>/profiles/default/
 * spike` inside `<filesDir>/profiles/default` (SessionServe.workspaceRoot /
 * FsPrimitives.appRoot). The gateway face is (scope, scope-relative path),
 * so the honest spelling of `<workspace>/plugins/registry.json` is
 * `<containerRoot minus fsScopeRoot>/plugins/registry.json` — e.g.
 * `spike/plugins/registry.json`. The bare `plugins/registry.json` spelling
 * (the pre-#346 provider, and the write legs' default) names the app scope
 * ROOT — the §4 pipeline's own plane — so the workspace tier degraded to an
 * empty list on every seat whose workspace sits below the root (every real
 * device seat) while the roster file existed one level down. A seat that
 * grants no separate scope root (the CLI probes: workspace == scope root)
 * derives the empty prefix and keeps the bare spelling.
 *
 * THE DOCUMENT: `dsh.plugins/1` — `{version: 1, plugins: [...]}`. Reads for
 * the LIST face are LENIENT (a missing file is the fresh roster — the
 * normal pre-creation state; malformed degrades, the caller warns). Reads
 * for the WRITE face are STRICT (a write into a roster this host cannot
 * parse must never silently land — rule 5, the #340 write-legs semantics).
 * Mutators are read-modify-write over injected fs primitives and NEVER
 * throw: every failure answers in-band (the #312 lesson — a throw here
 * would ride the resident dispatcher into the serial runtime thread).
 */

/** The UTF-8 face, resolved once: the spike host's node:buffer shim carries
 * decodeUtf8/encodeUtf8 (quickjs has no TextDecoder); real node runtimes
 * (the panel suite) answer the same face over the platform globals. Same
 * shape as web-write-plugin-manager.js's face. */
let utf8FaceCache = null;
const utf8Face = async () => {
  if (utf8FaceCache !== null) return utf8FaceCache;
  const spike = await import('node:buffer').catch(() => undefined);
  const spikeFace = typeof spike?.decodeUtf8 === 'function'
    && typeof spike?.encodeUtf8 === 'function';
  utf8FaceCache = spikeFace
    ? { decode: spike.decodeUtf8, encode: spike.encodeUtf8 }
    : {
      decode: (bytes) => new TextDecoder().decode(bytes),
      encode: (text) => new TextEncoder().encode(text),
    };
  return utf8FaceCache;
};

/** The UTF-8 decode face for readers outside this module (the tool's
 * manifest leg): the same spike-vs-platform resolution the doc reads use. */
export const decodeUtf8Face = async () => (await utf8Face()).decode;

/**
 * The workspace's app-scope-relative path prefix: `containerRoot` spelled
 * against `scopeRoot` — `''` when the workspace IS the scope root (or no
 * scope root is pinned), `'spike'` on the Android seat shape. Callers join
 * it as ``${prefix === '' ? '' : prefix + '/'}<relative>``.
 * @param containerRoot - the pinned workspace root (absolute), or undefined.
 * @param scopeRoot - the pinned app scope root (absolute), or undefined.
 * @returns the slash-free prefix, or ''.
 */
export const workspacePrefix = ({ containerRoot, scopeRoot } = {}) => {
  if (typeof containerRoot !== 'string' || typeof scopeRoot !== 'string') return '';
  if (!containerRoot.startsWith('/') || !scopeRoot.startsWith('/')) return '';
  if (!containerRoot.startsWith(`${scopeRoot}/`)) return '';
  return containerRoot.slice(scopeRoot.length).replace(/^\/+|\/+$/g, '');
};

/** The scope-relative join helper: `joinScoped(prefix, 'plugins/registry.json')`. */
export const joinScoped = (prefix, relative) => {
  const clean = String(relative).replace(/^\/+/, '');
  return prefix.length > 0 ? `${prefix}/${clean}` : clean;
};

/**
 * The workspace registry's gateway path: `<workspacePrefix>/plugins/
 * registry.json` (the bare spelling when the prefix is empty). Accepts the
 * same {containerRoot, scopeRoot} parts as workspacePrefix — the injection
 * seam the panel suite asserts the derivation through.
 */
export const workspaceRegistryPath = (parts) =>
  joinScoped(workspacePrefix(parts), 'plugins/registry.json');

/**
 * LENIENT registry read (the LIST face): a missing file answers the fresh
 * roster; an unparsable or off-version document answers a structured
 * failure the caller degrades with a warn. Never throws.
 * @param deps.fsRead - the gateway fsRead (injected: the panel suite's shim).
 * @param deps.path - the gateway path to read (workspaceRegistryPath).
 * @returns {ok: true, plugins} | {ok: false, code, message}.
 */
export const readWorkspaceRegistryDoc = async ({ fsRead, path }) => {
  const { decode } = await utf8Face();
  let raw;
  try {
    const { bytes } = await fsRead('app', path);
    raw = decode(bytes);
  } catch (error) {
    const code = error?.code === 'io' ? 'io' : error?.code ?? 'unknown';
    if (code === 'io') return { ok: true, plugins: [] }; // the fresh roster
    return { ok: false, code, message: String(error?.message ?? error) };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    return { ok: false, code: 'parse', message: `${path} is not valid JSON: ${error.message}` };
  }
  if (doc?.version !== 1 || !Array.isArray(doc.plugins)) {
    return { ok: false, code: 'shape', message: `not a dsh.plugins/1 document: ${path}` };
  }
  return { ok: true, plugins: doc.plugins };
};

/**
 * STRICT registry read (the WRITE face): same shape, but a missing file is
 * the fresh roster while anything unparsable or off-version is a structured
 * refusal — a mutate into an unreadable roster never lands.
 */
export const readRegistryStrict = async ({ fsRead, path }) => {
  const { decode } = await utf8Face();
  let raw;
  try {
    const { bytes } = await fsRead('app', path);
    raw = decode(bytes);
  } catch (error) {
    if (error?.code === 'io') return { ok: true, doc: { version: 1, plugins: [] } };
    return { ok: false, code: error?.code ?? 'unknown', message: String(error?.message ?? error) };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    return { ok: false, code: 'parse', message: `${path} is not valid JSON: ${error.message}` };
  }
  if (doc?.version !== 1 || !Array.isArray(doc.plugins)) {
    return { ok: false, code: 'shape', message: `not a dsh.plugins/1 document: ${path}` };
  }
  return { ok: true, doc };
};

/** Serialize + write one registry document back (the mutate tail). */
const writeRegistryDoc = async ({ fsWrite, path }, doc) => {
  const { encode } = await utf8Face();
  await fsWrite('app', path, encode(`${JSON.stringify(doc, null, 2)}\n`));
};

/** The registry row for `id`, or undefined. */
const rowOf = (doc, id) =>
  doc.plugins.find((row) => row !== null && typeof row === 'object' && row.id === id);

/**
 * Read-modify-write: upsert one roster row by id (unknown doc/entry fields
 * preserved — agent-authored rows carry fields this plane does not own, the
 * #340 write-legs semantic). Answers `{ok, changed, row}` or a structured
 * refusal; never throws.
 */
export const upsertRegistryRow = async ({ fsRead, fsWrite, path }, row) => {
  const read = await readRegistryStrict({ fsRead, path });
  if (!read.ok) return read;
  const doc = read.doc;
  const existing = rowOf(doc, row.id);
  let changed = false;
  if (existing === undefined) {
    doc.plugins.push(row);
    changed = true;
  } else {
    for (const [key, value] of Object.entries(row)) {
      if (existing[key] !== value) {
        existing[key] = value;
        changed = true;
      }
    }
  }
  if (changed) await writeRegistryDoc({ fsWrite, path }, doc);
  return { ok: true, changed, row: rowOf(doc, row.id) };
};

/**
 * Read-modify-write: drop the roster row named `id` (workspace FILES an
 * agent authored are not touched — only the roster row goes, the #340
 * remove semantic). Answers `{ok, removed}` or a structured refusal.
 */
export const removeRegistryRow = async ({ fsRead, fsWrite, path }, id) => {
  const read = await readRegistryStrict({ fsRead, path });
  if (!read.ok) return read;
  const doc = read.doc;
  const before = doc.plugins.length;
  doc.plugins = doc.plugins.filter((row) => row?.id !== id);
  const removed = doc.plugins.length < before;
  if (removed) await writeRegistryDoc({ fsWrite, path }, doc);
  return { ok: true, removed };
};

/**
 * Read-modify-write: flip one roster row's enabled flag (no-op when the row
 * already agrees). Answers `{ok, changed, enabled}` or a structured
 * refusal naming the unknown id.
 */
export const setRegistryRowEnabled = async ({ fsRead, fsWrite, path }, id, enabled) => {
  const read = await readRegistryStrict({ fsRead, path });
  if (!read.ok) return read;
  const doc = read.doc;
  const row = rowOf(doc, id);
  if (row === undefined) {
    return { ok: false, code: 'unknown-plugin', message: `no registry row names "${id}"` };
  }
  if (row.enabled === enabled) return { ok: true, changed: false, enabled };
  row.enabled = enabled;
  await writeRegistryDoc({ fsWrite, path }, doc);
  return { ok: true, changed: true, enabled };
};
