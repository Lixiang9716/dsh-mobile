# Agent Note: the forkpty face lands — honest PTY children for the terminal path (D-b)

Status: implemented

## Problem

The node-pty family of the upstream suite failed at its first real
terminal spawn: the vendored `@deepseek-ai/dsh-subprocess-local` terminal
path loads its backend through `createLazyRequire('node-pty')`, and the
require face answered `only relative package-style reads are served` —
the frozen contract has no pseudo-terminal primitive. Measured baseline on
the darwin CLI: `subprocess-local` shell-activity 0/7 (every test died at
the require), `tool-terminal` loader-composition 0/1 (the terminal session
spawn silently produced nothing), `terminal-controller` controller 53/2
(the real-shell test refused with `terminal inspection is unsupported on
platform mobile`, and the terminate fixture needed a mock face the harness
vi shim lacked). The owner decided the boundary (decision matrix D-b,
2026-09-29): an honest host `forkpty` face, NOT a pipe-backbone shim — a
shim over pipes would fabricate exactly the terminal facts (echo, job
control, foreground process group) the shell-activity detector measures.

## Decision

The D5 proposal `contract/proposals/2026-09-29-forkpty-face(.zh).md`
drafts the primitive (`ptySpawn` + the `pty.event` channel, grant `pty`,
audit on every call) as the **v1.9.0 candidate** — additive numbering
after the draft v1.6.0/v1.7.0/v1.8.0 candidates; the socket-seam draft
keeps v1.8.0, no collision. Implementation:

- **C seam** (`dsh_spike_host.c`): `__dshPtySpawn/Poll/Write/Resize/Kill`
  over `forkpty(3)` — `<util.h>` on Darwin/iOS, `<pty.h>` on the
  Linux-family hosts (verified against the iOS device SDK; bionic needs
  API 23+, the app's minSdk is 26), with a compile-out host answering a
  loud runtime error instead. The master fd is host-owned and
  non-blocking; the child is a session leader with the slave as its
  controlling tty; a missing workdir fails ENOENT pre-exec (the
  subprocess seam's contract); write backpressure parks in the slot and
  drains at poll; the pump contract mirrors `__dshProc*` (one
  non-blocking read pass + a WNOHANG reap per poll, EIO = the terminal's
  EOF shape). No threads, no C→JS calls (D2/D8 intact); teardown SIGKILLs
  and reaps tracked terminals.
- **JS shim** (`upstream/shims/node-pty.js`): the node-pty IPty surface —
  `spawn/onData/onExit/write/resize/kill` plus the pause/resume pair the
  vendored handle drives (consumer-side delivery gating; the host keeps
  reading) — running the same 4ms pump the node:child_process shim runs.
  Registered as the cjs-loader **builtin face** `'node-pty'` by
  `npm-bridges.js` (the 'ws' precedent), and `node-module.js` routes bare
  require requests through the cjs loader's table + builtin faces —
  behavior-equivalent for every existing path (the bundle seam never
  served a bare request).
- **Harness parity**: `upstream-harness-vi.js` gains
  `getMockImplementation` (vitest's face, the controller fixture reads
  it); `shims/expect-poll.js` AWAITS an async getter before matching —
  vitest parity, the shell-activity polls are `async () => (await
  handle.inspectActivity()).state` and previously every poll arm timed
  out printing "[object Promise]"; the suite leg's shell-suite platform
  pin (uname → `process.platform`) extends to the controller and
  shell-activity specs — their ps-based process inspector refuses on any
  spelling but darwin/linux/win32.
- **Embed lists** (hand-edited, per the vendor-package pin rules): iOS
  rides the whole `upstream/shims` TREES entry (automatic); Android's
  stager is wholesale; harmony gains `upstream/shims/node-pty.js` in
  `vendor-official.sh` CLOSURE and the Index.ets `BUNDLE_FILES` mirror —
  check-bundle-files 930 = 930 both directions after sync; the staging
  verifier's harmony warnings drop to 0 (the 20 advisory coverage misses
  are the pre-existing baseline, unchanged by this work).

Measured on the darwin CLI (`./build/dsh-spike-cli .
scenario/upstream-suite-leg.js --env
DSH_UPSTREAM_SPEC=upstream-tests/<spec>`): shell-activity **7/0**,
controller **55/0**, loader-composition **1/0** — every node-pty-family
spec the roadmap carried is green. A full-suite sweep rides the PR
description (both legs, the shared-face changes being the blast radius).

## Alternatives considered

- **Pipe-backbone shim** (fake TTY over the existing pipes): rejected by
  the owner (D-b) — echo, job control and the foreground process group do
  not exist over pipes; the suite would go green against semantics that
  are not there, which is the dishonesty rule 6 exists to prevent.
- **ishRun guest terminals**: complementary, not a substitute — a guest
  terminal lives inside the emulated Linux userland with its own pty
  driver and lifetime; the terminal path here spawns real-host children,
  the same trust shape the subprocess seam already carries.
- **Vendoring node-pty itself**: rejected (D6 + D2) — a native Node addon
  (N-API over libuv) has no QuickJS embedding and cannot be vendored
  verbatim without a build system the runtime does not have; the first-
  party face over the host seam is the outboard adaptation the
  architecture prescribes.
- **Status quo (stay excluded)**: rejected — the specs run today (staged
  since the staging gap rounds) and fail at runtime; exclusion would be
  the less honest bookkeeping, not a landing place.
