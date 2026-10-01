# iOS live test — four dimensions on the dsh-iphone simulator

[中文](ios-live-test-summary.zh.md)

Status: 10 of 14 legs green with receipts; 4 legs blocked by a machine-level
CoreSimulator XPC deadlock (see [BLOCKED-LEGS.md](../hosts/ios/artifacts/ios-live-test/BLOCKED-LEGS.md)).

This round ran the iOS host's live battery across four dimensions on the
`dsh-iphone` simulator (iOS 26.5, the only runtime whose dyld cache carries
libswiftWebKit), per the owner's brief: A — UI (control sweeps, session
surfaces), B — backend (gateway family, session, BYOK, real LLM), C — tools
(tool rows, todo, wasm, ish, office), D — capabilities (device plane, camera,
mic, BLE, marketplace). Evidence lives under
[hosts/ios/artifacts/ios-live-test/](../hosts/ios/artifacts/ios-live-test/),
organized per dimension (`A-ui/`, `B-backend/`, `C-tools/`,
`D-capability/`), each leg with `logs.txt`, `scenario.jsonl`, verdict JSONs,
a receipt, and PNGs; 17 representative shots are collected in
[deliverables/](../hosts/ios/artifacts/ios-live-test/deliverables/). Every
verdict is a one-to-one log assertion (the screenshots are the owner-named
deliverable, never a CI assertion).

## Green legs (12 scenario checkers across 10 legs)

| Leg | Verdict | Evidence |
|---|---|---|
| boot.verification / carrier.loopback / gateway.binding / gateway.audit | 8/7/19/16 events, all pass | `B-backend/gateway/` |
| session.mock-llm + webclient.mount (official client) | 23/7, pass | `B-backend/session-mock-llm/` |
| session.mock-llm + whale.mount (whale client) | 23/7, pass | `A-ui/whale-mount/` |
| nextweb.mount (self-hosted web-client-next) | 25, pass | `A-ui/nextweb-mount/` |
| composer.live-write (b4.write.live) | 46, pass | `C-tools/b4-write-live/` |
| device.plane + audit | 16/23, pass | `D-capability/device-plane/` |
| camera.plane + audit (sim: honest `unavailable`) | 6/3, pass | `D-capability/camera-plane/` |
| mic.plane + audit (real Mac-mic PCM frames) | 11/6, pass | `D-capability/mic-plane/` |
| ble.plane + audit (mock radio, full GATT ladder) | 16/8, pass | `D-capability/ble-mock/` |
| ble.plane + audit (real radio skip posture) | 8/4, pass | `D-capability/ble-skip/` |

## What the tools leg proved on-device

The b4 runtime half now probes all three execution seams on every run
(`log.debug`, so no canonical record moves):

- **tool rows**: the inventory event carries the composed rows —
  bash, bash-persistent, pwsh, pwsh-persistent, present, ralph, todo, fs,
  goal, skill, subagent, web, workflow … 15 tools in the prompt request.
- **dsh-shell-wasm echo**: a 77-byte `echo.wasm` written into the workspace
  and run through the gateway `wasmRun` → `output="hello from wasm"`,
  `result=15` (the module's own exit convention), with the structured-refusal
  ladder (missing export, missing module) probed beside it.
- **dsh-shell-ish**: a REAL guest run — `/bin/sh -c echo hello-from-guest`
  inside the emulated aarch64 Alpine userland, `exit=0`, stdout verbatim;
  the plugin reports `enabled:true` (active) with the userland staged.

## Bugs found and fixed in this round (each with live evidence)

1. **The iOS stager missed three upstream modules** (`llm-route.js`,
   `web-write-marketplace.js`, `web-write-onboarding.js`) — every drive whose
   import chain reached them died at eval (`cannot load module`), measured on
   the nextweb.mount leg. Fixed in `SpikeBundleStager.swift`.
2. **...and three more root modules** (`marketplace-resolver.js`,
   `canonical-json.js`, `ed25519.js`) one ring further — same live finding,
   same fix shape.
3. **`gen.sh` fetched the guest tarball after xcodegen read resources** — a
   fresh worktree's app shipped without `ish-rootfs.tar.gz`, so the ish
   plugin honestly declined activation (`unavailable: ... is missing`).
   gen.sh now stages it before `xcodegen generate`.
4. **The whale receipt named a verdict file that never exists** in whale mode
   (the carrier manifest flips to whale-mount.json) — the shared writer died
   after both checkers were green. One-line receipt-stems fix.
5. **The nextweb-mount manifest predated the BYOK boot probe** (and the
   composer manifest predated tool-rows / session-cancel / the mobile-default
   preset round) — both refreshed to today's wire, legs green 25/25 and
   46/46 in order.

## Blocked legs (honest skip, with reason)

- **Marketplace real install** (D): the drive is fully scripted
  (`run-marketplace-install.sh`: mock market server → catalog config staged →
  panel browse → install → progress → installed, PNG per step) and the
  enabler commit is in this branch (the seat relays
  `profiles/default/marketplace/config.json` into the write options); the run
  died with the machine's CoreSimulator wedge after the page mounted
  (one partial home screenshot exists).
- **BYOK onboarding flow** (B): scripted in `run-onboarding-sim.sh`
  (wrong-key 401 → success probe → save → first turn → relaunch).
- **Real LLM turn** (B): the staged-credential mechanism is verified
  (repo `.env` carries `DSH_LLM_*` → `api.deepseek.com`, the
  `51-run-ios-release.sh` staging path), but the Debug streaming leg and the
  Release turn need the simulator.
- **Control sweeps** (A): Debug + Release sweeps need WDA (simulator).

## Consequences

- The three stager fixes + gen.sh ordering are load-bearing for any future
  iOS leg: without them the BYOK, marketplace and onboarding runtime legs
  cannot boot on this host at all.
- The four blocked legs are one command each once the simulator service is
  restored (see BLOCKED-LEGS.md); nothing needs re-staging.
- `dsh-office` remains unmounted on iOS (the office leg stays a CLI/HarmonyOS
  story) — an honest platform gap, not attempted here.
