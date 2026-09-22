# Agent Note: one loader service serves both the presets inject and the client composition

Status: implemented
Related: none

## Problem

The official client's Agent 预设 screen errored (`gateway/unavailable`) because
the vendored AgentPresets service could not mount: it `inject`s the cordis
Loader service, and the web-boot client composition claimed the `loader`
context property itself — cordis refuses the second claim of one fiber
property. The 插件 screen errored (`gateway/unimplemented`) because
`pluginInventory/list` had no implementation on this host at all, and the
carrier only forwards endpoints the runtime claimed.

## Decision

One REAL cordis Loader service is mounted on the spine (upstream/boot.js);
web-boot's `mountClientModules` now DECORATES that service's
`entries()`/`internal` faces with the staged web-plugin rows instead of
claiming `loader` (and constructs the same real Loader itself on the bare
compose-only shape). AgentPresets mounts against it with
`{default: 'standard', includeUserRoot: false}` — the honest mobile root set.
`WRITE_ENDPOINTS` claims `agentPresets/list|read|copy|deletePreset|select`
forwarded to the real service with descriptor-exact wire names, and
`pluginInventory/list` is served by a new module (web-write-inventory.js):
an honest read-only snapshot of the live spine (every row from context
facts), the staged client bundles, and the 预设 compositions, with
`managementAvailable: false`. The plugin-manager's LIST legs
(`listBundles`/`listPlugins`) are claimed READ-ONLY — the settings 内置插件
section calls them with no managementAvailable gate (measured on device),
and the wire's own `readOnlyReason: 'management-required'` row member is
the designed honest disposition; the manager's WRITE legs
(`setBundleEnabled`/`setPluginEnabled`/`installBundle`/`removeBundle`/…)
stay unclaimed (fail loud, never faked).

## Alternatives considered

- Keep the minimal loader face and mount AgentPresets on a second context —
  rejected: two loaders in one context is exactly the fiber-property
  conflict, and the presets would read a different tree than the client
  composition.
- Synthesize `node_modules` health markers for unstaged packages so every
  preset reports healthy — rejected: lying about install state makes broken
  presets selectable; markers are generated only for packages this host
  actually vendors (ci/gen-presets-seed.py).
- Leave `pluginManager.listBundles/listPlugins` unclaimed — REJECTED AFTER
  MEASUREMENT: the sidebar plugin-manager panel gates on
  `managementAvailable`, but the settings 内置插件 section calls the list
  legs directly, so unclaimed left that panel on its 暂时无法读取插件
  error. The read-only claim with per-row `readOnlyReason` serves the list
  without presenting management as available (the write legs stay
  unclaimed).

## Consequences

Presets referencing unstaged desktop plugins answer honestly `broken`
(cordis currently lists 23 such rows); a fuller roster health lands as more
of the upstream plugin tier is vendored. Selecting a preset on a live
session attempts the real upstream mount and fails loud at the loader's
import refusal — the named staged gap.
