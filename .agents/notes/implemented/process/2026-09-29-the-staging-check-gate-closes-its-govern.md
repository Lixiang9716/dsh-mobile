# Agent Note: the staging-check gate closes its governance debts: the rule-6 rejection case, the self-test serialization edge, and the in-gate live-tree case mutex

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
serializing it after `self-test` — the only gate whose run mutates the live
tree at the DAG layer — matching every other tree reader (`closures`,
`bundle-files`, `quickjs-boot-parse`). The gate keeps its wave-1 blocking
form unchanged — no flag, no mode, no allowFailure moved. The plane is
re-sealed (one deliberate re-baseline; the reason is in the ritual ledger).

That DAG edge does NOT cover races inside `self-test` itself: govrail runs
project cases on a ThreadPoolExecutor (`self_test/_harness.py:24`
`CONCURRENCY = 4`; `self_test/__init__.py:342-346` submits every project
job to the pool, no mutex). Three of the seven project cases mutate the
live tree — `case-bundle-files.sh` (rawfile mv), `case-quickjs-boot-parse.sh`
(`fs-seeded.js` append), and this PR's new `case-staging-check.sh`
(`Index.ets` row removal) — and two of them have intersecting read
surfaces, measured both directions the day this note was first reviewed
(worktree 0a538482): inside the staging-check window
(`'upstream/boot.js',` gone) `node hosts/harmony/ci/check-bundle-files.mjs`
reports `rawfile file missing from BUNDLE_FILES: upstream/boot.js` exit 1,
so bundle-files' green leg would false-fail; inside the bundle-files window
(`composer-web-live.js` mv'd) `node tools/check-staging.mjs` reports
`STALE scenario/composer-web-live.js` exit 1, so staging-check's green leg
would false-fail. The pre-existing mutating pair (bundle-files ×
quickjs-boot-parse) had disjoint read surfaces, which is why the race class
stayed theoretical until this PR introduced the first intersecting pair.

So the mutation windows of the two intersecting cases now serialize on a
shared machine-local lock (`${TMPDIR:-/tmp}/dsh-gov-live-tree-case.lock`):
an atomic `mkdir` spinlock — portable where `flock(1)` is absent (macOS) —
with a 60s fail-loud deadline (a hang must not hold CI hostage) and a
stale-lock steal after 2 minutes (`find -mmin`, for a SIGKILLed case). Both
cases acquire before their first tree write and release after their final
green read; the trap releases only a lock the case actually holds.

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
  reason the 2026-09-26 note records: `check-staging.mjs` and
  `check-bundle-files.mjs` hardcode the repo's paths, so a redirect seam is
  a checker change riding an infra fix. Factually: four of the seven
  project cases are sandbox-clean (`case-code-size`, `case-e2e-matrix`,
  `case-logging`, `case-logging-l4` — `mktemp -d` fixtures); three mutate
  the live tree (`case-bundle-files`, `case-quickjs-boot-parse`, and this
  new case). The new case is NOT sandbox-clean — it holds the live-tree
  lock instead. (An earlier draft of this note miscounted this as
  "sandbox-clean like five of the six"; corrected in review.)
- **Move the new case's mutation to a disjoint surface (the android
  stage-spine rows) so the pair stops intersecting** — rejected: it does
  not disjoint them. The bundle-files window (rawfile `composer-web-live.js`
  mv'd) turns ANY staging-check green leg red — the harmony manifest rows
  name that file, harmony is a blocked host, exit 1 — regardless of which
  surface the staging case itself mutates.
- **The govrail exclusive lease for project cases (upstream fix)** — the
  durable home, already the 2026-09-26 note's filed upstream ask; the local
  lock is the effective-today guardrail and stays correct even after
  govrail changes.
- **Leave the `needs` edge to a future race report** — rejected: the
  race signature is already twice-recorded telemetry (the closures flakes,
  the surprise ledger); wiring the edge now is cheaper than the third
  occurrence the process would then owe a note for.
