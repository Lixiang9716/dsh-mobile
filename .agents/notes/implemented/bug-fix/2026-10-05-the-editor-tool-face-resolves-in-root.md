# The editor tool face resolves in-root relative spellings like the read face

Date: 2026-10-05
Round: loop-z3 (r17 battery follow-up), card T-0200

## Problem

The r16 battery (V2(c), release 105abafa) measured the model driving
`str_replace_editor view` on the in-root relative spelling
`spike/../plugins/registry.json` and getting refused:

```
Error: The path spike/../plugins/registry.json is not an absolute path, it
should start with `/`. Maybe you meant /spike/../plugins/registry.json?
```

The turn ended there (no retry). Driving the refusal's own suggestion
answered `does not exist` (V2(c2), FS_NOT_FOUND): on this host a leading `/`
is the DEVICE root, so the hint was a self-defeating dead end. Only the full
absolute `..` spelling resolved (V2(c3)).

The queue line suspected a #380 (loop-v2) regression: "the same spelling
resolved fine in r14". That hypothesis does not hold, and the correction
matters for future bisects:

- The refusal text is the vendored package's own gate — `resolveTarget`,
  `tool-str-replace-editor@0.1.6-alpha.2/lib/index.js:69`
  (`if (!isAbsolute(path)) throw ... Maybe you meant /${path}?`). The
  package is byte-identical between r14's 318fb22e and 105abafa
  (`git diff 318fb22e HEAD -- .../tool-str-replace-editor@0.1.6-alpha.2` is
  empty), so the gate predates #380 and existed in r14 too.
- The r14 probe drove a DIFFERENT tool: its prompt said "use your read tool"
  and the journal shows `"name":"read"` on the same relative spelling
  (battery-r14 w2 journal, seq 35) — SUCCESS. The r16 probe's prompt let the
  model choose, and it picked `str_replace_editor` (v2c journal, seq 68).
  The read face resolves relative spellings against the workspace cwd
  inside vendored fs-local (`localDisplayPath`/`resolveLocalTarget`,
  fs-local lib/index.js:152-167) — the #356 model directory semantics — and
  still passes on 105abafa (in-process probe over the real vendored tools,
  this round).
- #380 only changed the OUTSIDE-root answer shapes (statSync anchors what
  the host holds, fs-stat.js:130-134; vfsRealpath keeps absence node-shaped,
  fs-paths.js:103-105). A relative spelling that resolves inside the root
  never reaches either arm.

The defect is real regardless of the wrong suspect: one model face accepts
the workspace-relative directory language (read), the other refuses it
(editor) and its refusal teaches a device-root spelling that cannot work.

## Decision

The editor's model-supplied `path` is anchored at the mounted workspace root
BEFORE the vendored handler runs — normalization first, inside/outside +
existence second, matching how the read face already behaves:

- New seam `runtime/spike/upstream/tool-path-anchor.js`:
  `anchorModelPath(path, root)` joins non-empty relative spellings at the
  root verbatim (physical `..` kept — the exact absolute-`..` shape the r16
  battery proved resolving); absolute spellings pass byte-identical; empty
  inputs pass through so the vendored empty-path answer stands.
  `applyWithAnchoredModelPaths(scope, plugin, root)` registers the vendored
  plugin through an `Object.create(scope)` proxy whose only override is
  `tools.register`, wrapping `execute` to anchor `args.path` — the vendored
  execute (argument validation included) still runs.
- `boot.js mountFileTools` mounts the editor through an inline cordis plugin
  (`name`/`inject` preserved) that calls the seam; the read face and every
  other tool row are untouched.
- The misleading "maybe you meant /X" branch is unreachable for model input
  (no suggestion is the ask's second accepted arm). A relative spelling that
  climbs OUT of the root (e.g. `../../../../etc/passwd`) anchors first and
  then refuses at statSync's loop-v2 containment gate (EACCES anchor), so
  the #380 boundary loses nothing.
- Panel: `tool-fs-outside-root-order.test.js` gains the anchor unit tests and
  a child-process runner (`toolface-relative-spelling-runner.mjs`) driving
  the REAL vendored tools through the production registration seam — the
  r16 spelling resolves and serves the registry, relative absence answers
  honestly with no suggestion, the gate text never appears, the loop-v2
  three forms hold through the tool face post-wrap, and the read-face
  control pins the unchanged #356 semantics. The loop-harness gained loader
  map rows for the two vendored tool packages plus test-only
  dsh-tools/dsh-sandbox stubs (registry/sandbox faces are not the behavior
  under test).
- Closures synced android + harmony; the harmony closure roster
  (`vendor-official.sh`, `Index.ets`) carries the new seam file.

## Alternatives considered

- Patch the vendored `tool-str-replace-editor` — rejected: upstream
  discipline (D6) forbids modified vendored copies; adaptations live
  outboard.
- Make the `node:path` shim's `isAbsolute` accept relative spellings —
  rejected: node-exact semantics everywhere (the shim's stated contract);
  it would also change the answer for every other importer.
- Change the fs-local `resolve` (or the `fs` shims) to translate the gate —
  impossible: the vendored gate runs BEFORE `ctx.fs.resolve`, so no fs-side
  change can reach it.
- Give the refusal a workspace-root-anchored suggestion instead of
  anchoring — rejected: it keeps two directory languages on the model face
  and keeps a refusal where the read face answers; anchoring makes the
  question moot and matches the ask's "no suggestion" arm.
- Re-register a shadow `str_replace_editor` tool after the vendored plugin
  mounts — rejected: registry shadowing semantics are upstream-owned;
  wrapping at registration is one interception point with no duplicate.

## Consequences

- The model can use ONE directory language across `read` and
  `str_replace_editor` for in-root relative spellings; absolute spellings
  and the outside-root boundary answers are byte-identical to pre-fix.
- The vendored gate stays upstream-verbatim; if upstream later accepts
  relative paths itself, the anchor becomes a no-op for absolute inputs and
  can be dropped in one place.
- The panel tool-face harness now drives the real vendored tool packages
  (loader map rows + stubs), available to future rounds.
