# The preset join lands in the harmony user-facing boot

Date: 2026-10-08 · Class: feature · Card: T-0048 (tail item)

Status: implemented

## Problem

The harmony user-facing boot (the write-live runtime half,
`harmony-composer-live-write.js`) publishes its boot agent into the empty
global layer: `boot.js` mounts the Agent 预设 roster AFTER agent-loop and
never joins any preset at agent-creation — the vendored service's own
`agent/created` warning fires on every boot, and the four preset tool rows
(bash/pwsh/present/ralph) never appear in the session toolset. The 10-08
device round (#417/#418) put that truth on the log (`spine.tools.mounted`,
16 tools, none of the four) and named the missing piece: mounted-in-boot
awaits the preset-join. Harmony also never staged the deployment's default
preset document (`AGENT_PRESETS_DEFAULT = 'mobile'`) — its roster answered
`default: null` while iOS (which stages `presets-mobile/mobile/*` into the
vendored presets copy) answered `default: "mobile"`.

## Decision

- `upstream/boot.js` exports `joinDefaultPreset(ctx, agent)`: the vendored
  service's OWN mount primitive (resolve → standing mount → scope bind),
  fail-loud when the default preset is unresolvable or the agent already
  joined. It is a helper, not boot behavior — the parity/CLI boots are
  untouched.
- The seat opts in via `runtime.config`'s `presetJoin` flag (the same seam
  as `commands`/`goals`/`skills`/`creation`). The harmony write leg
  (`OfficialPhase.openLegWithRuntimeConfig`) sends `presetJoin: true`. The
  composer joins the boot agent at the booted hop (the seed lands before
  the config on this leg, so the roster is readable there), emits
  `spine.preset.joined` (preset id + the four rows' honest per-row state
  from the LIVE composition), and reads `spine.tools.mounted` from the
  agent-scoped registry view — the same resolver the model-facing catalog
  reads.
- `web-write.js`'s session-create joins the deployment default for sessions
  the page creates under the same flag — "changing the default takes
  effect on the next session created" is the vendored selection policy's
  own semantics, and the turn the page drives is the user-facing proof.
- `vendor-official.sh` stages `presets-mobile/mobile/{preset.yml,
  agent.cordis.yml}` INTO the vendored presets copy at
  `vendor/dsh/agent-presets@…/presets/mobile/` (never the tracked vendor
  tree — the iOS embed's rule), with a byte-verify twin; Index.ets's
  BUNDLE_FILES carries the two rows. The roster becomes five presets,
  `default: "mobile"`.
- `run-device-parity.sh`'s tool-rows ASSERT moves to 5/5 + `default:
  mobile` for the same reason.

What the device rounds surfaced while landing this (each fixed in the same
change):

- The web-boot loader's `internal.import` stub ("client bundles are served,
  never executed") refuses the composition's row imports on the full-spine
  shape too — it now delegates to the runtime's own importer there and keeps
  the refusal on the bare compose-only shape.
- The preset documents' grouped rows (`planning`/`compaction`/`delegation`)
  import the `cordis:group` builtin — the deployment must register the
  loader's own `Group` plugin; boot.js does.
- The composition's rows inject host services no flag mounted:
  `tokenMeter`, `jobs` (the ABSTRACT seam — the LOCAL implementation
  `dsh-jobs-local` backs it, its npm face staged at the dsh rel path),
  `userQuestions`, `subagentModelSelection` (tool-subagent refuses its
  `modelSelectionSettings: true` row without it), and `shell` + `shellEnv`
  for tool-bash — the wasm executor (dsh-shell-wasm's exported
  `shellExecutor`, the backend the ported dsh-shell subclass was always
  meant to wrap) backs the vendored ShellExecutor, background `start`
  refusing honestly. boot.js boots this plane under `presetJoin`
  (boot-coverage-rows.js's `mountCompositionHostPlane`).
- `tool-workflow` joins the seed-side mobile-wall set
  (preset-mobile-rows.js): its `workflowEngine` rides the PTC host runner —
  no stub would be honest.
- The join composes on the host's UI thread (the runtime's serial queue),
  and the booted hop's origin open lands its ArkWeb nweb creation on that
  SAME thread — a join composing immediately at the hop starved the
  creation and the page never loaded (two runs wedged); a quickjs timer is
  never pumped in this embed. The join defers to the page's FIRST api
  delivery — the proof the webview is up.
- `run-host-e2e.sh`'s capture pulls now remove-then-demand each file: `hdc
  file recv` exits 0 even when the transfer fails, and the failed pulls
  left the PREVIOUS run's captures in place — the checkers judged stale
  evidence green (measured: three runs). run-device-parity.sh gets the same
  discipline plus its `grep'dsh.runtime'` typo.

The four rows' per-row truth after the join: `bash` and `present` mount
visible into the session toolset; `pwsh` carries the upstream
platform gate (`win32`-only — no PowerShell exists on the device) and
`ralph` the upstream default-off gate; both ride in the live composition
inventory with their conditions, resolving through their on-device markers.
Forcing them visible would hand the model tools that cannot execute —
the exact "host availability alone grants no tool" shape the shipped docs
warn against.

## Alternatives considered

- **Join inside `boot.js`'s mount sequence**: rejected — the presets seed
  reaches the runtime AFTER the boot on host-delivered legs, so a mount-
  time join fails loud on every seat that stages data late; and the CLI/
  parity boots must stay byte-identical (the committed parity golden).
- **Join unconditionally when the default resolves** (no seat flag):
  rejected — iOS stages the mobile doc already, so the next iOS device run
  would shift its pinned `tools: 15` manifest without fresh iOS evidence.
  The flag keeps the change on the seat that carries the evidence; the
  iOS/Android seats adopt it in their own rounds.
- **Enable pwsh/ralph in the mobile preset doc**: rejected — a registered
  tool with no working executor on the platform lies to the model; the
  upstream docs keep ralph off by default deliberately.

## Consequences

The harmony write-live E2E asserts the joined composition by logs
(`spine.preset.joined` + the grown `spine.tools.mounted` + the request
toolset count). The interactive seat and the Android/iOS seats keep the
historical no-join shape until their rounds pass the flag and stage the
doc; their manifests are untouched.
