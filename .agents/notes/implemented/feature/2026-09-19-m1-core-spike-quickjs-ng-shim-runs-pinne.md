# Agent Note: M1 core spike: quickjs-ng shim runs pinned upstream util-crypto with log-verdict E2E

Status: implemented
Related: D1

## Problem

M1 spike A ("quickjs-ng shim running upstream pure-logic packages") had no
concrete seam definition: which upstream package, which engine pin, how a
platform host embeds the engine, and what evidence proves the spike on each
platform. Without that seam fixed first, the three platform spikes
(iOS/Android/HarmonyOS) would each invent their own engine version, their
own log format, and their own "it works" story — unverifiable against each
other and against the log-based E2E contract.

## Decision

`runtime/spike/` lands the shared core, and `tools/e2e/` the shared
verdict tool:

- quickjs-ng pinned verbatim at v0.17.0 (commit 6d46d07) — pinned by
  `vendor/ensure.sh` (upstream tarball, sha256-verified) and the vendor
  tree is untracked (gitignored): the engine's real-world C cannot pass an
  editor-level tree-sitter parse (`gov check --all` counts 2283 findings
  across the vendored tree), the compiler is the authority the gate itself
  defers to, and committing the bytes would make every future `--all`
  sweep red without catching a single real defect. Library sources only —
  `quickjs-libc` excluded, the spike host provides its own glue
  (`runtime/spike/host/dsh_spike_host.c`), so no thread/subprocess surface
  enters the runtime and every platform links the identical C.
- upstream `@deepseek-ai/dsh-util-crypto@0.1.6-alpha.1` vendored verbatim
  (zero-dependency pure logic; sha256 in its PROVENANCE.md). The shim
  supplies the Web-API seams it needs (`crypto.getRandomValues`,
  `btoa`) — adaptation lives in the shim, never in the vendored copy (D6).
- `scenario/m1-spike-boot.js`: scenario `m1.spike.boot` emits 9 ordered
  events through a plain-ESM port of the unified logger; the gateway
  bridge (contract v1.0.0) proves negotiation (`gateway@1`), an async
  primitive call settled by the host on a LATER pump tick (fsRead), and
  the declared-unavailable conformance path (keychainGet) — the D2
  coroutine/no-subprocess model exercised for real.
- `tools/e2e/check.mjs`: one-to-one expected<->logged matcher per
  scenario manifest; the canonical `dsh.spike.log: {...>` line is
  byte-identical on every platform, so one checker serves macOS CLI,
  iOS, Android, and HarmonyOS hosts. Its rejection case was exercised:
  a log missing one event FAILS with the exact index named.
- `tools/check-logging.py` gains a scope rule: files under a `/vendor/`
  segment are out of the unified-logging contract (vendored upstream
  packages are kept verbatim and cannot declare our logger — same class as
  the pre-existing tools/ exclusion). Its rejection teeth were re-proven
  after the change: a tracked scratch module with a bare console call
  trips L1+L2+L3 (exit 1); vendor exclusion is not a gate parking.
- macOS CLI proof run committed under `runtime/spike/artifacts/macos-cli/`
  (logs, verdict, receipt): PASS 9/9 in order.

Platform hosts (iOS / Android / HarmonyOS) embed this core unchanged and
differ only in build system, thread glue, native-log capture, and
screenshot tooling.

## Alternatives considered

- `session-persistence` as the spike package: rejected — its peer
  dependencies (@deepseek-ai/cordis) pull a framework into the spike;
  util-crypto is genuinely zero-dependency, so the shim stays minimal.
- Running the scenario via quickjs-ng's own `qjs` CLI: rejected — the
  embeddable C API (`dsh_spike_new/eval/pump`) is the actual seam every
  platform host needs; a CLI-only proof would validate nothing about
  embedding, and quickjs-libc brings the thread/timer surface the
  architecture forbids.
- Per-platform E2E checkers: rejected — the "nothing missing, nothing
  extra, in order" contract is platform-independent; only the capture
  differs, and a shared checker keeps scenario manifests the single
  source of expected behavior.
- Screenshots as the platform verdict: rejected — constraint 7 keeps
  verdicts on structured logs; platforms still capture screenshots as
  local evidence for humans.
