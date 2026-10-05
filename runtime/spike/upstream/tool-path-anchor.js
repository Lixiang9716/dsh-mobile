// dsh:logging-exempt (seam layer)
/**
 * upstream/tool-path-anchor.js — the model tool face's relative-path anchor
 * (loop-z3, 2026-10-05). The vendored str_replace_editor refuses every
 * relative spelling at its own absolute-path gate (resolveTarget, vendored
 * tool-str-replace-editor lib/index.js:69) and suggests "maybe you meant
 * /X" — a leading-/ spelling that on this host is the DEVICE root, measured
 * a dead end (the r16 battery v2c2 drove the suggestion and got
 * FS_NOT_FOUND). The read face accepts the same spellings (fs-local resolves
 * them against the workspace cwd — the #356 model directory semantics), so
 * the model sees two contradictory directory languages and the r16 session
 * tripped on exactly that (v2c: turn ended, no retry).
 *
 * Anchoring the model-supplied `path` at the mounted workspace root BEFORE
 * the vendored handler runs puts the editor face on the read face's
 * semantics: the gate (and its misleading suggestion) is unreachable for
 * model input, absolute spellings pass byte-identical (the loop-v2 three
 * forms stand), and `..` climbing stays PHYSICAL — fs-local keeps the raw
 * spelling and the shim realpath resolves it, exactly the absolute `..`
 * spelling the r16 battery proved resolving (v2c3). A relative spelling that
 * climbs OUT of the root still refuses at statSync's loop-v2 containment
 * gate — normalization first, inside/outside + existence second.
 */

/** The anchored spelling of a model-supplied tool path: absolute paths are
 * returned unchanged; non-empty relative spellings join the workspace root
 * verbatim (no lexical normalization — the same physical shape fs-local's
 * localDisplayPath builds for the read face). Empty/whitespace inputs pass
 * through so the vendored gate keeps its own empty-path answer. */
export const anchorModelPath = (path, root) =>
  typeof path === 'string' && path.length > 0 && !path.startsWith('/')
    ? `${root}/${path}`
    : path;

/** The cordis plugin boot.js mounts in the vendored editor's place: same
 * name and inject rows (the fiber identity the mount order and inventory
 * read), an apply that hands the vendored apply a PLAIN registration
 * delegate wrapping each registered tool's `execute` so the model-supplied
 * `path` arrives anchored (see anchorModelPath); the vendored execute —
 * argument validation included — still runs on the anchored args.
 *
 * The delegate is deliberately NOT derived from the cordis scope: a context
 * object rejects service-property writes from another fiber (`cannot set
 * property "tools" in multiple fibers`, measured by the iOS e2e on the
 * first push), and the vendored apply + handlers touch exactly tools.register
 * / fs / get / emit (the fs/observed events) — the faces the delegate serves
 * from the real scope. */
export const anchoredEditorPlugin = (plugin, root) => ({
  name: plugin.name,
  inject: plugin.inject,
  apply: (scope) => plugin.apply({
    tools: {
      register: (tool) => scope.tools.register({
        ...tool,
        execute: (args, exec) => tool.execute(
          { ...args, path: anchorModelPath(args?.path, root) }, exec),
      }),
    },
    fs: scope.fs,
    get: (key) => scope.get(key),
    emit: (...argv) => scope.emit(...argv),
  }, {}),
});
