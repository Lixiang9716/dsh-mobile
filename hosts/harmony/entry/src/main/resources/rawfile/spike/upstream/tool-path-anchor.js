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

/** Apply a vendored tool plugin with its registrations' `execute` wrapped so
 * the model-supplied `path` argument arrives anchored at `root` (see
 * anchorModelPath). The scope proxy delegates every context face to the real
 * cordis scope; only `tools.register` is intercepted, and only this plugin's
 * registrations flow through it (the vendored apply registers exactly one
 * tool). The wrapped call still runs the vendored execute — argument
 * validation included — on the anchored args. */
export const applyWithAnchoredModelPaths = (scope, plugin, root) => {
  const anchored = Object.create(scope);
  anchored.tools = {
    register: (tool) => scope.tools.register({
      ...tool,
      execute: (args, exec) => tool.execute(
        { ...args, path: anchorModelPath(args?.path, root) }, exec),
    }),
  };
  return plugin.apply(anchored, {});
};
