# Agent Note: the workspace registry reads the workspace: containerRoot-derived gateway paths for the 插件 tier, the write legs and the tool

Status: implemented
Related: issue #346 (workspace tier device path); builds on the #334
workspace tier and the #340 write legs

## Problem

The device battery's 插件 inventory answered 29 session rows and an EMPTY
workspace tier while the workspace's own `dsh.plugins/1` registry existed
on disk (`files/profiles/default/spike/plugins/registry.json`, pulled as
`registry-after-round.json` in the battery evidence). The provider —
`scenario/write-surface-options.js` `readWorkspaceRegistry` — read
`fsRead('app', 'plugins/registry.json')`, and the gateway's reserved `app`
scope root is `<filesDir>/profiles/default/` (`FsPrimitives.appRoot`): the
read named the app scope ROOT, one level ABOVE the workspace. The
workspace is the profile container (`runtime.config containerRoot` =
`SessionServe.workspaceRoot` = `<filesDir>/profiles/default/spike`), so
the honest spelling is app-scope-relative `spike/plugins/registry.json`.
The missing read is a plain `io` miss, which the provider's degrade path
keeps quiet (only non-`io` failures warn) — the tier degraded to empty
silently on every real device seat, exactly where the one-sentence-creation
path writes its roster.

The #340 pluginManager WRITE legs read and write the SAME bare spelling
(`REGISTRY_PATH = 'plugins/registry.json'`), so fixing only the provider
would have split the plane: a settings-panel install's roster adoption
would land beside the §4 trees at the app scope root while the tier listed
the workspace document.

## Decision

The registry path is DERIVED, not spelled: the app-scope-relative prefix of
the workspace — `containerRoot` minus `fsScopeRoot` (`spike` on the Android
seat; the empty prefix when the workspace IS the scope root or no scope
root is granted, which keeps the bare spelling for the CLI drive seats) —
joined with `plugins/registry.json`. One home for the derivation and the
document face: `system-plugins/dsh-plugin-manager-tools/registry.js`
(the plugin_manager tool's own module — `workspacePrefix`,
`workspaceRegistryPath`, lenient read / strict read / row mutators, all
in-band), imported by:

- `scenario/write-surface-options.js`: the LIST provider derives the path
  from the boot config (injected parameters — the derivation is asserted
  directly by the panel suite), and the write options carry the derived
  `registryPath`;
- `upstream/web-write.js`: relays `options.registryPath` into the write
  surface deps;
- `upstream/web-write-plugin-manager.js`: `makePluginManagerWriteHandlers`
  accepts `deps.registryPath` (default stays the bare spelling for the
  historical drive seats whose workspace is the scope root) — install
  adoption and enable flips land in the SAME document the tier lists.

The plugin_manager tool (#346 item 3) reads the same module with the
pinned globals (`__dshProfileCwd` / `__dshProfileScopeRoot`, the shell
executor's `scopePathFor` convention, tolerant where the shell refuses —
the tier is advisory and must degrade, never throw, the #312 lesson).

## Alternatives considered

- **Move the write legs' registry to the workspace root too, hard-coded**
  (`fsWrite('app', 'spike/plugins/registry.json')`): bakes one platform's
  workspace layout into upstream code and breaks the CLI drive seats whose
  workspace IS the scope root. The injected derivation keeps each seat's
  geometry where the boot actually states it.
- **Read through the vendored fs service** (the workspace VFS the file
  tools use) instead of the gateway: the VFS is in-memory and boot-scoped —
  the registry must survive relaunches, and the device-verified roster
  (countdown10) lives on the gateway scope's disk, not in the VFS world.
- **Rename the workspace document** (e.g. `dsh.plugins.json`) to avoid the
  collision with the §4 plane's root document: breaks the device-verified
  file and the `patchId: 'plugins/registry.json'` identity the LIST legs
  already publish; the tier and the tool now agree on the workspace file
  as it exists on devices.
