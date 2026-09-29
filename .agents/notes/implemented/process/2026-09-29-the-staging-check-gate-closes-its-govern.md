# Agent Note: the staging-check gate closes its governance debts: the rule-6 rejection case and the self-test serialization edge

Status: implemented
Related: D5
Related: .agents/notes/implemented/process/2026-09-29-staging-manifests-are-gate-pinned-to-the.md
Related: .agents/notes/implemented/process/2026-09-26-serialize-the-tree-mutating-rejection-case-ahead.md

## Problem

The wave-1 landing (678d99dc) wired the `staging-check` gate hard
(`--block harmony,android,ios`, in the `all` mode, sealed) but left two
governance debts, both visible in the plane's own telemetry. `gov self-test`
reported `staging-check(NONE — rule 6)`: the gate had no rejection case, so
the proof that it actually intercepts a staging gap existed nowhere — the
gate could rot into a vacuous script unnoticed. And the gate declared no
`needs`, while it reads the harmony rawfile, android assets and ios bundle
trees: scheduled at `concurrency: 4`, it could run concurrently with
`self-test`, whose `case-bundle-files.sh` `mv`s a rawfile file away for its
proof window — the exact parallel-DAG race that flaked `closures` twice on
CI (run 2026-09-26 morning, PR #223) before the 2026-09-26 serialization
note gave the tree readers `needs: ["self-test"]`. `staging-check`, added
two commits later in wave-1, silently missed that edge.

A second discrepancy surfaced the same session: the follow-up brief
expected the gate still UNwired (owner decision D-e: wire warn-first, flip
hard after the owner signs off the triage zero). Reality: wave-1 already
flipped it hard, and D-e's own flip condition — triage zeroed (all 23 gaps
closed) plus owner sign-off (the wave-1 PR landed under the standing D-h
auto-merge authorization) — was already satisfied. Recorded as surprise
telemetry; the hard state is the pre-authorized end state, not an overrun.

## Decision

`gates.json`'s `staging-check` gate declares `needs: ["self-test"]`,
serializing it after the only tree-mutating gate, matching every other tree
reader (`closures`, `bundle-files`, `quickjs-boot-parse`). The gate keeps
its wave-1 blocking form unchanged — no flag, no mode, no allowFailure
moved. The plane is re-sealed (one deliberate re-baseline; the reason is in
the ritual ledger).

`.gov/rejections/case-staging-check.sh` ships the rule-6 proof: it removes
the single `'upstream/boot.js',` row from harmony's `Index.ets`
BUNDLE_FILES — a boot entry the import graph always reaches, so the row's
absence is the minimal REAL gap (the fresh-install death the tool exists
for) — runs the gate's exact argv (`--json --block harmony,android,ios`),
asserts exit 1 with the gap's JSON row naming `upstream/boot.js`, restores
byte-identically, and asserts the same run green. 2.3s, inside the 10s case
budget; passes in `gov self-test` (tools 56 + project 7).

## Alternatives considered

- **Demote the gate to warn (allowFailure) to honor the brief's "warn
  first" literally** — rejected: the brief's premise (gate unwired) was
  stale, and D-e's flip condition was already met by the wave-1 landing;
  demoting a hard gate to advisory is loosening a gate to make a change
  brief fit, the one direction this plane never takes. The warn MODE still
  exists in the tool for any future host triaged as mitigated-elsewhere
  (a host leaves `--block` only with a recorded triage).
- **A second, warn-only gate running the same checker** — rejected:
  duplicate execution of a 1s tool to manufacture a "warn" surface the
  brief's premise no longer needs; two gates over one checker is drift
  surface, not evidence.
- **Sandbox the rejection case into a temp-tree copy** — rejected for the
  reason the bundle-files case keeps: the proof's contract is "the checker
  against the REAL tree"; the mutation is one committed manifest row with
  a byte-identical restore, so no sandbox is needed and the case stays
  sandbox-clean like five of the six existing cases.
- **Leave the `needs` edge to a future race report** — rejected: the
  race signature is already twice-recorded telemetry (the closures flakes,
  the surprise ledger); wiring the edge now is cheaper than the third
  occurrence the process would then owe a note for.
