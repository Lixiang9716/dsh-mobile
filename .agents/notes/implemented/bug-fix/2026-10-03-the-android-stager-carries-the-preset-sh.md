# Agent Note: the android stager carries the preset shell-surface npm faces at the dsh rel paths (#324)

Status: implemented

## Problem

On the release seat (build `d14680a`, plain launch), three of the four
built-in Agent preset cards in 设置 → Agent presets read 加载失败 —
Standard, PTC, and Creator — while Minimal was healthy. The endpoint
answered (`agentPresets/list` claimed), so the failure was the service's
per-preset health verdict, and with the cards broken no new task could
select a mode at all — Creator mode's plugin-magic surface was unreachable.

The health rule is the vendored `dsh-agent-presets` discovery: a preset is
`broken` when any row it would start names a module that cannot resolve,
and on every mobile host a package row resolves through ONE channel — the
node_modules markers the seeders write, one per staged `vendor/dsh/*`
package (`AgentPresetsSeed.kt`, the iOS drive's `agentPresetsSeedDelivery`,
harmony's `OfficialServe`, `gen-presets-seed.py` — the same rule four
times). Running the real vendored discovery against the real staged seed
data pinpointed the single unresolvable row each broken card shared:
row `present` → `@deepseek-ai/dsh-tool-present`. That package is pinned on
the NPM face only (`NPM_PACKAGES`); no `vendor/dsh` tree exists for it, so
the android stager — unlike the iOS embedder, whose TREES list has carried
an npm-face block staging present/ralph/bash/pwsh AT the
`vendor/dsh/<pkg>@<ver>` rel paths for exactly this seeder — never shipped
the bytes, no marker was written, and every composition naming the row
(that is all three) read broken. Minimal does not name the row, which is
why exactly one card was healthy.

## Decision

`hosts/android/ci/stage-spine-closure.sh` now stages the same four
npm-face packages the iOS embedder stages — `tool-present`, `tool-ralph`,
`tool-bash`, `tool-pwsh` — from their npm pins to the
`assets/spike/vendor/dsh/<pkg>@<ver>` rel paths (LICENSE + package.json +
lib minus `.d.ts`, the `stage_pkg` lean rule), and its byte-identity check
judges the same four against their npm pins. The committed assets carry
the staged trees; `AgentPresetsSeed` then writes a marker for each (name
read from the staged package.json), the `present` row resolves, and the
real vendored health check reports all four presets healthy over the
staged seed data. The staged `tool-bash` copy from the #170 submodule era
was refreshed to the npm pin's bytes (workspace-protocol package.json →
published manifest; same name and version, so its marker is unchanged).
A regression leg in the panel suite
(`test/panel/preset-health.test.js`) asserts, over the tracked staged
documents and the tracked staged marker set, that every preset is healthy
after the seed's mobile-absent patch and that no unresolvable row falls
outside the patch list — it fails naming the row and the package.

## Alternatives considered

- Add `tool-present` to `DSH_PACKAGES` in `ensure-dsh.sh` (a dsh-face pin,
  mirror tarball already tracked). Lost: iOS and harmony already consume
  the npm face through their own embed mechanisms, so a dsh-face pin would
  put a third copy of the bytes in the closure and split the three hosts'
  staging stories; the npm-face-at-dsh-path arrangement is the house
  pattern the iOS embedder documents for preset-riding packages, and the
  manifest generator (`gen-staging-legs.mjs dshRosterRows`) already
  derives exactly these rows from the npm face.
- Teach the three seeders to also walk `vendor/npm` faces. Lost: the
  markers are the honesty boundary — the staged `vendor/dsh` set is what
  the mobile closure actually serves, while `vendor/npm` holds test faces
  and desktop-only engines (e.g. `dsh-tool-ralph`'s subprocess engine)
  that must NOT resolve on mobile. Writing markers for npm faces would
  mark unrunnable packages healthy.
- Add the `present` row id to `MOBILE_ABSENT_ROW_IDS` in
  `upstream/preset-mobile-rows.js`. Lost: mobile genuinely carries the
  capability (the boot's creation row mounts a mobile port of this exact
  tool), the package loads clean under the vendored faces (its only
  imports are schemastery/dsh-fs/dsh-tools, all vendored), and disabling
  the row would silently strip the delivery tool from every standard/PTC/
  Creator session once preset mounting lands — a capability regression
  parked as a "fix".
