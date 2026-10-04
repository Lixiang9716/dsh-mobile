# Agent Note: the session toolset carries the plugin pipeline: the plugin_manager tool mounts on the mobile spine

Status: implemented
Related: D6; issue #346 item 3; builds on the #340 write legs, the #334
workspace registry tier, and the tool-cordis decision in
upstream/preset-mobile-rows.js

## Problem

The real-model device battery (2026-10-04, issue #346) failed its
creation+install leg on the session toolset, not the runtime: the Creator
composition's `tool-plugin-manager` row has been Enabled since #334 (the
preset inspector shows it), but the turn's agent reported — honestly — "no
plugin manager, no registry, no install command", then hand-rolled its own
registry file instead of calling a tool. Three facts compose the root cause:

1. The composition chain never composes on this host: the boot agent joins
   no preset (`upstream/boot.js`'s documented staged gap — upstream's own
   `agent/created` warning names it), so composition rows are inventory
   documents, never mounts.
2. Even a compose could not mount this row: the vendored
   `@deepseek-ai/dsh-plugin-manager/tools` injects
   `['tools', 'pluginManager', 'sandboxPolicy']` — the mobile spine mounts
   neither service (and its execute reads an `approval` service the seat
   does not run either). The packages are vendored, but the desktop
   policy/approval MACHINERY those services implement is not — the same
   shape as tool-cordis, left out deliberately with the same reasoning
   (preset-mobile-rows.js).
3. The runtime-side backend EXISTS (#340: the §4 pipeline, the receipts
   journal, the workspace registry — served as pluginManager api legs), but
   nothing exposed it to the model: the api plane is page-facing wire, not
   a tool.

A live reproduction under Node (boot.js `bootUpstream`, the vendored spine,
plain Node via the upstream-suite loader face) confirmed the gap at the
assertion that matters: `ctx.tools.view(undefined).visible` carried 15
tools and no `plugin_manager`.

## Decision

The plugin pipeline is a session toolset row:
`system-plugins/dsh-plugin-manager-tools` (outboard implementation package,
D6 — the same shape as dsh-open-design / dsh-shell-wasm), mounted by
`mountSpine` beside the other tool rows and registered into the REAL
ToolRuntime. After the boot, `ctx.tools.view` carries `plugin_manager`
(reproduction now asserts 16 visible tools; the spineInventory row
`tool-plugin-manager` answers enabled: true, fiberPhase: 'active').

The tool keeps the vendored tool's name and action vocabulary
(`plugin_manager`; list_plugins / list_bundles / set_plugin / set_bundle /
install_bundle / remove_bundle) so prompts and compositions that reference
the ecosystem name stay meaningful. Its backend is the mobile plane:

- list/set/remove operate the WORKSPACE `dsh.plugins/1` registry — the
  same document the 插件 LIST legs' manageable tier serves (see the
  companion note on the registry's path; the face is shared:
  `registry.js` in the package, imported by
  `scenario/write-surface-options.js` too).
- install_bundle adopts a WORKSPACE-AUTHORED tree: the spec is a bare name
  resolved at `plugins/<name>/manifest.json` under the workspace, validated
  against the workspace-authored manifest grammar (id/version/entry — the
  device-verified one-sentence-creation shape), then upserted as a roster
  row. Catalog installs (marketplace index → §4 fetch) stay the settings
  内置插件 api legs in v1; a spec with no workspace tree refuses in-band
  naming the search.
- Every leg answers in-band (the #312 lesson): refusals carry the #340
  ChangeResult vocabulary (`invalid-spec` / `unknown-plugin` /
  `not-found` / `operation-error`), the tool boundary never throws.

Synced to all three host closures (android assets, harmony rawfile +
BUNDLE_FILES, iOS generated bundle — regenerated).

## Alternatives considered

- **Join the boot agent to a preset so the composition row mounts**
  (`AgentPresets.mount()` in the agent factory setup): the faithful desktop
  shape, but it needs the `pluginManager` + `sandboxPolicy` services and
  the approval machinery — the #335-B carrier-scale work, and the #340
  note already chose the mobile backend semantics over the desktop
  machinery. The composition row's Enabled declaration becomes TRUE on
  this seat via the spine mount instead; the composition chain itself
  stays future work.
- **Mount the vendored tool module directly** with stub services: fakes the
  desktop approval posture (`approveEscalation`/`danger-full-access`) the
  mobile host cannot honor — dishonest where the outboard package is
  honest about what it manages.
- **A new tool name** (`workspace_plugins`): breaks the ecosystem
  vocabulary the composition row, the preset documents, and the model's
  prior knowledge all reference; the name costs nothing and the parameter
  surface is a strict subset.
