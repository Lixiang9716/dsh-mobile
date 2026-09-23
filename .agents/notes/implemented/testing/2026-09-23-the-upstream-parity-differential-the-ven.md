# Agent Note: the upstream parity differential — the vendored spine verified against itself under Node

Status: implemented

## Problem

The D9 proof (`upstream.session`) asserts the vendored upstream spine runs
inside quickjs, but its expected log is hand-written: nothing compares our
port's behavior against what the SAME vendored packages produce under the
host upstream itself targets. Compatibility with upstream was claimed by
construction (verbatim packages) and by spot assertions — never measured as
a differential. The user asked for exactly that measurement, run through
simulators.

## Decision

A parity harness lands with three legs around one shared projector:
(1) the REFERENCE leg (`runtime/spike/ci/parity-reference.mjs`) composes the
vendored spine under plain Node — the same closure, the same plugin configs
and identities — importing our gateway transport adapter VERBATIM through a
one-import loader redirect (`ci/parity-node-hooks.mjs` → a Node-fetch bridge),
so both legs execute the same wire/SSE/translate code; (2) the PORT leg
(`scenario/upstream-parity.js`) drives the same scripted turns (success → a
todo_write tool round → closing success → 401) through the real mobile
profile boot inside quickjs — on the CLI (macOS CI; Linux cannot link the
vendored iSH-arm64 engine) and on the Android emulator (MockLlmRoute armed
with the parity script, endpoint facts over the runtime.config bus
delivery); (3) the SHARED projector (`scenario/parity-projector.js`)
normalizes both session logs (deterministic fields kept, container-path and
tool-roster-dependent renderings masked by replacement, never omission) and
`ci/parity-compare.mjs` demands record-for-record identity, failing loud at
the first divergence. The Node reference's projection is frozen as a
committed golden (`test/e2e/fixtures/upstream-parity-reference.jsonl`, 25
records, byte-reproducible) which every port leg and every future reference
run must reproduce — the refresh is a deliberate `--update-golden` act.
Node resolution of the vendored packages goes through a runner-materialized
`runtime/spike/vendor/node_modules` symlink layout (Node realpaths symlinked
imports, so the layout must sit on the vendored tree's own ancestor chain)
plus the same errors-only session-persistence shim the quickjs loader
serves. State at landing: reference leg green and golden frozen; the
Android leg is wired but its first on-device run surfaced a host-detection
bug (the shared C host defines `__dshLaunchEnv` on every platform — fixed by
keying on the snapshot's contents) and the rerun continues in the follow-up;
the scenario manifest, CI wiring, and matrix rows land with that green run.

## Alternatives considered

- **Run upstream's own vitest suites against our runtime** — rejected: the
  suites need the Node test toolchain itself (vitest, jsdom); quickjs cannot
  host them, and Node running them tests upstream, not our port.
- **Assert the port leg against another hand-written expected log** —
  rejected: that is the status quo's shape; it cannot detect a divergence
  where BOTH our boot and our expected log drift from upstream together.
  The reference leg is the oracle precisely because it is upstream's own
  packages under upstream's own host.
- **Ship a Node-side re-implementation of the transport for the reference** —
  rejected: two adapter implementations could diverge and the differential
  would then measure the wrong seam. The loader redirect keeps the adapter
  bytes identical on both legs.
- **Compare raw session JSON byte-for-byte** — rejected: the records embed
  uuids and timestamps; the shared projector's masked projection is the
  honest comparison plane (and the masking is shared code, so it cannot
  hide a divergence from one side only).
