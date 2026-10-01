# Agent Note: CI honesty two moves — the staged-tree invariant becomes a real gate, and the vendor ensure path fails loud with names

Status: implemented

Related: supersedes (in part) the "deliberately did NOT become a sealed-DAG
gate" decision inside
`2026-09-30-driver-presentation-node-faces-carry-real-coverage.md`; builds on
`2026-09-21-the-vendored-fetches-retry-a-transient-f.md`.

## Problem

Two honesty gaps where a promise lived outside the machine that should
enforce it:

1. **The staged-tree invariant was CI-only (A12, #288).**
   `presentation/web-client-next` is whole-tree staged into the harmony HAP
   rawfile, and the "exactly its shipped files" check lived only inside
   `tools/test/run-presentation-tests.sh` — a step of the CI `gates`
   workflow, not a gate in `gates.json`. The measured cost: #288 passed a
   local `gov run` 20/20 green and failed in CI on exactly this class.
   The 2026-09-30 note had deliberately kept it out of the sealed DAG
   because adding a gate moves the plane seal's rules hash and staled every
   open task card fleet-wide — that PR observed the churn live and reverted.
2. **A vendor download failure surfaced without a name (C34, #289
   feedback).** The feedback: a download failure in the vendor ensure path
   was swallowed — the job learned of the gap only later, when a downstream
   gate tripped over the missing tree. Forensics on the current code
   (before this change) could NOT reproduce a literal exit 0: hard network
   failure already exited 1 under both `/bin/sh` flavors available (bash
   3.2 and dash — measured in this session). What the forensics DID find:
   - the wrong-bytes class (HTTP 200 with a truncated/corrupt body — the
     upstream re-cut family, measured twice in 2026-09) died at a bare
     `shasum -c` whose only message named a mktemp temp file — no package,
     no source, no expected digest, and **no retry** on the digest leg
     (one transiently corrupt fetch = instant cryptic death), while
     `ensure-dsh-tests.sh:130` had already established the digest-retry
     pattern;
   - `ensure-zstd.sh` was the one download site the 2026-09-21 retry fix
     missed — bare `curl` flags only, no `fetch_retry` helper;
   - nothing in the scripts re-checked the pin tables after the fetch
     loops — a row that slipped through surfaced only at a later gate,
     exactly the reported shape.

## Decision

**A12 — the gate.** `webclient-staged-tree` joins the sealed DAG
(`gates.json`, hand-compiled: command, description, `needs: ["self-test"]`
per the bundle-files-class convention, `timeoutMs` 60s, and the
`modes.all` membership). The check lives in
`tools/check-webclient-staged-tree.sh` (one home for the count: 16 shipped
files); `run-presentation-tests.sh` now delegates its pre/mid/post
asserts to the same script instead of carrying a second copy. The
rejection case `.gov/rejections/case-webclient-staged-tree.sh`
institutionalizes the ask's counter-proof: one unsynced file in the staged
tree must turn the gate red naming the count, and removal restores green
(`gov self-test --scope project`: project 10, all pass). The seal was
re-baselined (`gov verify-plane --write --confirm-unattended`, reason
recorded in the ritual ledger), and the nine stale cards were advanced
with `gov task repin` and a recorded reason — the sanctioned path the
2026-09-30 revert predated; the churn it feared is now a recorded act, not
a reason to keep the promise unwired.

**C34 — fail loud, named.** All four download-carrying ensure scripts
(`ensure.sh`, `ensure-wasm3.sh`, `ensure-zstd.sh`, `ensure-dsh.sh`) share
the hardened pair:

- `fetch_retry`: the window sized for CI's cold materialization — 5 outer
  attempts, inner curl `--retry 2 --retry-delay 3 --connect-timeout 20
  --max-time 300`, waits 5/10/20/40 (~75s of pacing, up to 15 dials, still
  bounded). Validated live: this sandbox's github.com connectivity flaked
  and then fully dropped mid-session, and the window recovered the wasm3
  tarball twice where the old 3×5s window family would have had one more
  dry attempt.
- `fetch_verified <label> <url> <out> <sha>`: download + integrity as ONE
  bounded unit — a 200-with-bad-bytes refetches (up to 3 fetches) and then
  fails loud naming the label, the source URL, and the expected digest.
  The 2026-09-21 note's invariant is preserved, not weakened: a corrupt
  artifact still cannot be accepted — it is refetched, bounded, then named.
- `ensure-dsh.sh` gains a **final verification pass** (top-level, outside
  the fetch pipelines' subshells): every pin row must sit on disk with
  `package.json` and a stamp naming ITS digest, else a `MISSING/UNSTAMPED`
  line naming row + pin + source and a non-zero exit — the script is its
  own gate instead of a later gate's prey.

## Counter-proofs (all run in this session)

- A12: `sh tools/check-webclient-staged-tree.sh` with a temp file added →
  `FAIL — presentation/web-client-next holds 17 files, expected exactly 16`
  naming the offending untracked path, exit 1; file removed → `OK — … 16
  shipped files`, exit 0.
- C34, hard network failure (curl shim exiting 97): `ensure.sh` → exit 1,
  `vendor: wasm3 0.9.0 — download FAILED after retries from
  https://github.com/wasm3/wasm3/archive/refs/tags/v0.9.0.tar.gz`;
  `ensure-dsh.sh` → exit 1, `vendor: npm/cordis@4.0.2 — download FAILED
  after retries from https://registry.npmjs.org/@deepseek-ai/cordis/-/cordis-4.0.2.tgz`
  (after `download attempt 5/5 failed` pacing); `ensure-zstd.sh` → exit 1,
  `vendor: zstd 1.5.7 — download FAILED after retries from …`.
- C34, wrong bytes with HTTP 200: `ensure.sh` → exit 1, `vendor: wasm3
  0.9.0 — sha256 MISMATCH after 3 fetches from … (expected cab79ce74…)`;
  `ensure-dsh.sh` → exit 1, `vendor: npm/cordis@4.0.2 — sha256 MISMATCH
  after 3 fetches from … (expected 686ca44f…)`.
- C34, final pass red leg (fetch loops stubbed in a /tmp copy): exit 1
  with all 60 dsh + 26 npm rows named `MISSING/UNSTAMPED … — pin …, source
  …`, ending `upstream DSH closure INCOMPLETE — … refusing to report
  ready`. Green leg runs on every materialization (`closure ready` prints
  only after the pass).

## Alternatives considered

- **Keep the invariant CI-only and instead add the runner as a CI-only
  assertion** (the 2026-09-30 shape): rejected by the ask — a promise the
  local DAG cannot check is prose, and #288 is the measured cost. The
  fleet-wide staleness objection is answered by `gov task repin`, which
  did not exist as the sanctioned path at revert time.
- **One shared `vendor/lib.sh` instead of four helper copies**: rejected —
  the scripts are deliberately standalone provenance records (D6); a
  sourced library would couple four independently-runnable pins.
- **Retry above verification** (fetch N times, verify once at the end):
  rejected — the 2026-09-21 note's own words: a retry policy above the
  check accepts a bad artifact more persistently. Verification wraps each
  fetch inside `fetch_verified` instead.
- **Also hash-verify full trees on the fast path** (guard partial cache
  restores): out of scope — the stamp + package.json fast path is the
  recorded design; the final pass now catches unstamped/partial rows by
  name, and a content-level re-verify of every file per run would tax the
  96-row cold path for a class the digest-stamped fetch already prevents.

## Consequences

Local `gov run` now carries the staged-tree invariant (the #288 class
fails before push, not in CI); the count has one home. Vendor download
failures are impossible to misread: every terminal message names the
package, the source, and the expected digest, and every exit is non-zero.
The `plane` gate's seal moved once, deliberately, with the reason in the
ritual ledger; future gate additions owe the same two recorded acts
(re-seal + repins). A govrail UX bug was hit en route: `gov task check`
prescribes `gov task re-pin <id>` but the parser only accepts `gov task
repin` — filed as field feedback with this task's report.
