# Agent Note: the harmony parity leg lands behind a launch-selected scenario, and the device runner reports standby instead of waiting

Status: implemented

## Problem

Decision D-g (2026-09-29 owner matrix) committed "scripts ready on standby"
for harmony real-device verification (roadmap items 6 and 8): one command,
the moment a device is attached, produces (1) the upstream parity receipts
—the 25-record golden both iOS and Android already meet—and (2) the T-0048
item 3 tool-rows on-device mount proof. Two blockers stood in the way:

1. **The harmony host had no parity leg.** `scenario/upstream-parity.js`
   was staged in the rawfile closure (BUNDLE_FILES) but no ets code ever
   evaled it — the legs were llm/whale/nextweb/device-plane/suite only. A
   runner alone could never drive the parity differential: it would fail
   loud with `unknown dsh.e2e.leg` — "ready" that isn't.
2. **No on-device surface named the tool rows.** The interactive seat's
   `settings.plugin.inventory` record aggregated preset composition rows
   into a count (`presetRows`); nothing on-device named which tool packages
   resolved, so a receipt could only say "something resolved".

## Decision

- **`upstream.parity` is a launch-selected leg** (`--ps dsh.e2e.leg
  upstream.parity`), the device-plane leg's shape: `HostPhase.beginParity`
  starts the runtime, evals the canonical scenario, and delivers the
  `runtime.config` bus message the scenario's `hostFacts()` already awaits
  (`{mockLlmUrl, apiKey, containerRoot}` — the Android armed-MockLlmRoute
  handoff, built into the committed scenario). The scenario file itself is
  untouched: the shared differential harness stays one file across hosts.
- **The scripted route is an in-app carrier route** (`ParityMockRoute` on
  the leg's own CarrierServer, `/parity-mock/chat/completions`): per-call
  behaviors in script order (success → todo_write tool-call → success →
  401) with the vendored llm-mock-server's wire shapes. In-app is what
  makes a REAL device work — the device's loopback is its own, so the
  iOS-style host-side mock server is unreachable there.
- **The tool rows are named on-device**: `composer-web-live.js`'s
  `settings.plugin.inventory` record now carries `toolRows` — the composed
  compositions' rows whose module is a staged `@deepseek-ai/dsh-tool-*`
  package, unique+sorted. A row exists only if its preset composed, and a
  composition breaks loud when a row's package is missing, so the named
  list IS the mount proof (T-0048 item 3). Existing manifests are
  unaffected: matchers assert listed fields, not whole records.
- **The runner is standby-first**: `hdc list targets` is read ONCE up
  front; no target → a standby report and exit 0. Presence is never
  waited on (the ask's rule; rule 8 applied to presence — a device arriving
  is an event for the human, not a poll). After a target is found every
  wait polls a condition with a deadline and fails loud (rule 5). Evidence
  faces match the matrix's deliverable set (`logs.txt`, `scenario.jsonl`,
  `receipt.json`) under `hosts/harmony/artifacts/device-parity/{parity,
  tool-rows}/`.
- **Two main-breakage classes the first device run exposed, fixed in the
  same change** (both killed EVERY harmony device leg since #251, not just
  this one):
  - *Hidden files cannot ride the HAP/APK*: the packers drop dotfiles, so
    #251's pi-ai `providers/data/.manifest.json` BUNDLE_FILES row died at
    `materializeBundle` before any scenario ran. The bytes now stage under
    the non-hidden alias `manifest.json` (harmony + android), the
    npm-bridges-pi-ai.js seam reads the literal dot name where it exists
    (desktop/iOS embeds) and falls back to the alias, and
    check-bundle-files rejects any hidden rawfile file (rejection case
    `case-bundle-files-dotfile.sh`).
  - *Hand-committed copies outside the closure verify freeze silently*:
    vendor-official's hand-listed CLOSURE never covered gateway.js (plus
    logger.js/registry.js and eight upstream/shims + scenario rows), so
    #251's `socketListen` and later shim evolution never reached the
    rawfile — on-device evals died one missing export at a time. The core
    rows joined CLOSURE; every BUNDLE_FILES row with a canonical source is
    now byte-verified (drift sweep clean).

## Alternatives considered

- **Runner-only, no host leg** — rejected: the one-click promise would be
  a script that fails loud `unknown dsh.e2e.leg: upstream.parity` on the
  device. Standby means READY, not ARMED-TO-FAIL.
- **Extending the vendored parity scenario to take a harmony path** —
  rejected: the scenario is the shared differential harness; forking it
  per host re-opens the byte-identity contract the comparator enforces.
  The runtime.config handoff was already designed in (the Android shape).
- **Reusing the interactive seat's mock route (`/mock-llm`) for the parity
  leg** — rejected: it serves marker-selected scripts (GAME_TURN /
  CREATE_TURN) with one-shot latches for the web-boot drives; the parity
  script's four-call sequence needs its own cursor, and sharing a route
  would couple two legs' state.
- **A new dedicated presets-probe leg** for the tool-rows proof —
  rejected: `nextweb.mount` already boots the interactive seat whose
  scenario runs the settings probes before any page interaction; one more
  leg is surface without new evidence.
- **Pinning `healthy: 4` alone** as the tool-rows proof (no scenario
  change) — rejected: a count cannot name WHICH rows resolved, and the
  receipt would assert causality ("all healthy therefore the four
  resolved") instead of reading it.
