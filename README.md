# dsh-mobile

English | [简体中文](README.zh.md)

A **mobile host** for the DSH (DeepSeek Harness) ecosystem. Built on the community Fabric interoperability model, dsh-mobile makes mobile a first-class peer host of the Harness runtime: a QuickJS single-threaded coroutine runtime carries the Harness core, iOS system capabilities are wrapped as a three-layer stack (privileged layer / capability gateway / system implementation plugins), and the UI itself is a pluggable Web Client plugin.

> Community project, not an official DeepSeek product. Upstream ecosystem: [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) and the DSH Community Fabric draft RFCs.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — layered design, key technical decisions, milestones
- [Build](BUILD.md) — one build facade: platform-selectable, compile + test, the closures gate
- [Release packages](docs/release.md) — tag-triggered versioned releases and packaging for the three host apps

## Milestones

| Phase | Scope | Status |
| --- | --- | --- |
| M0 | Primitive contract v0 + data protocols (bundle layout / manifest / receipt) | Done (frozen v1.0.0) |
| M1 | Spikes: quickjs-ng shim over upstream pure-logic packages + iOS host skeleton + local carrier | Done (runtime spike verified on iOS/Android/HarmonyOS + macOS; local carrier — loopback static files + WS↔QuickJS pump — verified on the iOS simulator) |
| M2 | System implementation plugins (fs/subprocess/ui) + Web Client mount + first on-device session + real LLM API | Done (system plugins + Web Client mount + first on-device session: `dsh-fs`/`dsh-subprocess-quickjs`/`dsh-ui` plugins, `session.mock-llm` 23/23 on the CLI and on-device, Web Client `dsh-web-client` mounted and rendered live over the carrier WS — evidence `runtime/spike/artifacts/macos-cli-m2-session/` and `hosts/ios/artifacts/m2-session/`; the REAL LLM API shipped as scenario `llm.live-stream`: an OpenAI-compatible streaming chat client (`runtime/spike/llm.js`) over the gateway `httpFetch` shape, leg negotiated from the RuntimeDescriptor — scripted-SSE leg on the CLI `llm.live-stream` 19/19 (`runtime/spike/artifacts/macos-cli-m2-llm/`), real z.ai streaming on the iOS simulator (`hosts/ios/artifacts/m2-llm/`) and the Android emulator (`hosts/android/artifacts/m2-llm/`) with reasoning+content deltas as an event sequence, the served model logged verbatim, and the API key audited against every log line (fail loud on a leak)) |
| M3 | Plugin install pipeline + UI pluggability (three plugin levels, capability negotiation) | Done (install = receipt transaction over the frozen fs primitives — `install.verified-tarball` 22/22 on the CLI: content-addressed blob, trust-record verify, strict manifest validation, install-time capability negotiation against the RuntimeDescriptor, staged integrity read-back, receipt commit, tampered package rejected before unpack; the FETCH-based installer runs the streaming httpFetch body through the same pipeline — CLI with a logged stub `install.full-cycle` 41/41 (`runtime/spike/artifacts/macos-cli-m3-complete/`), ON DEVICE against the loopback carrier itself with the real `httpFetch` `install.from-http` 46/46 + carrier evidence `install.carrier-evidence` 11/11 (`hosts/ios/artifacts/m3-complete/`), including pending-receipt STARTUP REPLAY over the append-only receipt journal (staged-verifies → committed, staging-incomplete → rolled-back, tree untouched); all three UI-plugin levels verified on device — the config layer (`cordis.patch` overrides) selects the active Web Client and overrides the toolbar slot set, plus whole-client swap and component slot (`ui.client-swap` 7/7, `hosts/ios/artifacts/m3-pluginization/`); regressions `session.mock-llm` 23/23 CLI + on device, `run-ios.sh` 4/4) |
| M4 | Android host (QuickJS-isomorphic) | Done (completion session `android.capability-binding` 35/35 green on the emulator: the loopback carrier serves the embedded Web Client into a real WebView with the session rendered live, and the nine-primitive gateway binding is real — descriptor 9 available / 0 unavailable, mandatory audit re-verified via `gateway.audit` 16/16; the three-scenario regression stays green in the same run — evidence `hosts/android/artifacts/m4-complete/`; the same real httpFetch binding drives the real-LLM streaming session `llm.live-stream` on the emulator — `llm.live-stream` device 14 expected / 171 logged + carrier 7/7, evidence `hosts/android/artifacts/m2-llm/`) |
| M5 | HarmonyOS host (ArkTS + NAPI) | Done (isomorphic host verified: loopback carrier — HTTP static serving of the Web Client + RFC 6455 WS pump — with ArkWeb mounting the live session, and ALL NINE contract primitives real on the emulator with descriptor 9 available / 0 unavailable: notify, presentApproval, fsScope, HUKS-sealed keychain (AES-256-GCM; set → get returns identical bytes, set null deletes), presentPicker over DocumentViewPicker (dismissal → null; grant → user scope with fsScope persist/resolve and content-matching read-back; user-scope surface read-only, matching the Android twin), and streaming httpFetch against the host's own loopback carrier (body settles at headers then streams as chunk events, never a whole result; mid-body abort → `cancelled`) — `harmony.capability-binding` 27/27 plus the `boot.verification`/`gateway.bridge-smoke`/`session.mock-llm` (23/23) regression in one launch — evidence `hosts/harmony/artifacts/m5-host/` and `hosts/harmony/artifacts/m5-primitives/`; the `llm.live-stream` real-LLM leg is WIRED on this host too — launch-selected by `aa start … --ps dsh.e2e.leg llm.live-stream` (the leg runs alone, so the default chain spends no serve quota), the canonical `runtime/spike/scenario/llm-live-stream.js` negotiating the real leg over the SAME httpFetch binding, with the platform-forced credential handshake (runtime-written 0666 placeholder → runner `hdc file send` → app import, honest seal report, removal after the run) and the carrier mount chain (`client.selected` → `webclient.mounted` → `ws.connected` → `slot.registered`) verified on the emulator; its TRANSPORT round trip is proven end-to-end — the request left the device through this host's httpFetch and the backend answered (honest HTTP 429 code 1310, the account's exhausted coding-plan quota, reset 2026-09-22 14:43:53) — so a SERVED turn is NOT claimed: it lands with the quota reset by re-running `hosts/harmony/ci/run-llm-live-stream.sh` (evidence `hosts/harmony/artifacts/m5-m2-llm/`, key-leak audit clean on the raw streams)) |

### Upstream port (D9)

The table above records what each milestone proved on its own evidence. Since decision
[D9](docs/decisions.md), the Harness layer itself is no longer an in-house reimplementation:
the upstream DSH runtime runs **verbatim** on quickjs — 26 packages pinned and sha256-verified
by `runtime/spike/vendor/ensure-dsh.sh` (21 upstream DSH packages at 0.1.6-alpha.2 + 5 pinned
npm deps), with in-house code reduced to glue (shims, adapters, the contract carrier). Live
through the carrier on iOS / Android / HarmonyOS: the official client-modules web boot, the
official app shell (the 58-package application tier, #61), real `session.list`/journal, and
the composer write path. The consolidated numbers and per-dir inventory:
[docs/e2e-matrix.md](docs/e2e-matrix.md) — 35 evidence dirs, 78 green verdicts (2 quota-blocked red, disclosed) — under
`hosts/{ios,android,harmony}/artifacts/` (`b1-official-web`, `session-live-read`,
`composer-live-write`, `android-upstream`, `android-session-live`, `d9-official-web`,
`d9-session-live`, `d9-write-live`).

## Governance

This repository is gated by [govrail](https://github.com/Lixiang9716/govrail): pre-commit content gates, a `gov run` gate DAG before push, CI enforcement (`.github/workflows/gov.yml`), and the multi-agent development practice its `agent-heavy` preset describes (`parallel-workers` skill + the `verify-decisions` gate). Run `gov --help` (installed via `pip install govrail`; entry point is `gov`).

## License

MIT
