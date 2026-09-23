# Agent Note: the agent-loop group goes 51 → 7 on our runtime — loop.spec 65/65 — with the remaining seven named at the async-context boundary

Status: implemented

## Problem

The owner's bar: the `core/agent-loop` group (the spine package, 19 specs /
307 tests upstream) fully green on our runtime. The session started it at
256 passed / 51 failed with 8 spec-level blocks; the merged #167/#169
(timer seam, harness surfaces) had not yet been combined with the
submodule-built package closure.

## Decision

Five gap classes closed, in measured order:

1. **The loader's extensionless subpath** (`dsh-session/invariant` →
   `lib/invariant`, no `.js`) — the vendored-packages probe now appends the
   extension when the sub names none.
2. **The unpublished-package closure, built from the submodule**: the pinned
   monorepo's `build:lib:host` output (26 workspace packages: the
   session-persistence family, shell/subprocess/sandbox backends, format
   migrations, ptc-runtime …) vendored under `vendor/dsh/` with
   `source=third-party/deepseek-harness@ddefc45f` stamps, plus
   exports-map subpath normalization (`./projection` → `lib/types/projection.js`
   flattened to `lib/projection.js` — 27 mappings, 148 flattened files).
3. **Three host shims**: `node:perf_hooks` (ms-resolution performance.now —
   the honest ceiling without a monotonic JS clock),
   `@deepseek-ai/node-addon-system/flock` (upstream's OWN single-process
   semantics: the in-process write claim excludes every writer, so the lock
   request succeeds without a resource), and `fast-check@4.8.0` +
   `pure-rand@8.4.0` (the monorepo's own lockfile pins) with fast-check
   pre-bundled to one self-contained ESM file (its chunk imports under the
   package name; esbuild's `nodePaths` fed it pure-rand).
4. **The CLI timer seam** (contract v1.4.0): `timerSchedule`/`timerCancel`
   in the smoke backend — settle on ARM, a live-timer table, and the run
   loop's one sleep: quiescent with armed timers → sleep to the earliest
   `fire_at` → deliver `timer.fire` → pump. `setImmediate` joins the
   ambient shim (0-delay arm — a macrotask, not a microtask).
5. **Harness surfaces**: `expect.poll` (condition poller pacing the real
   timer seam) and Set equality in deepEqual (membership, not order).

Stack: quickjs guards JS recursion against the C stack it consumes, so the
CLI now runs its driver on a 512 MB-stack pthread with a 400 MB JS limit
(8 MB on the default main thread SEGFAULTED; plain recursion then measured
past 100k frames — the knob works, the C thread was the binding constraint).

Result: **298 → the remaining failures are 11 tests + 4 spec-blocks**
(post-session correction: the count and the classification below said 7 /
"one async-context root" — the ENGINE async-context work has since LANDED
(probe-proven: a store survives await AND host-event hops, parity
golden-identical) and the failures DID NOT MOVE, so the single-root claim is
DISPROVEN; they are per-test semantic/stack issues needing Node-diffing.
The engine work stands on its own merit — see
architecture/2026-09-23-dsh-mobile-maintains-its-own-quickjs.md):
loop.spec **65/65**, cancel 39/39, tool-calls 21/21,
contract-regressions 33/33, coverage-edges/interception/properties/request-*
all green. The seven: agent-initiator ×5 + scope-lifecycle ×2 — all the
ALS/initiator-scope class; the async-hooks shim's Promise-patch model is
invisible to **async/await** (quickjs's await machinery does not pass
through the patched `.then`), so cross-await context propagation needs an
engine-level mechanism (Node's ALS is native for exactly this reason). The
bridge for cross-TIMER propagation landed (arm-time capture wraps the fire)
but the await boundary remains. The four blocks: `node:zlib`'s zstd face ×3
(the same wall the upstream baseline hits on darwin-arm64 — a real codec
workstream) and `dsh-llm-pi-ai/src/context.ts` ×1 (a TS-source deep
export; transpile-strategy decision pending).

## Alternatives considered

- **Fake zstd / fake ALS** — rejected: both would pass tests by lying; the
  failures are named instead.
- **Raising only the JS stack knob** — rejected after measurement (the C
  stack is the real constraint; the thread wrapper is the fix).
- **Solving await-context in the shim** — rejected for this change: it
  cannot be done from JS; the note names the engine-level design as the
  follow-up.
