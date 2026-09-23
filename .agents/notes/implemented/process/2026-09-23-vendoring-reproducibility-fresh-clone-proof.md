# Agent Note: vendoring-reproducibility — the fresh-clone proof for the vendor scripts

Status: implemented
Related: D6, T-0044, surprise:the-vendor-scripts-pass

## Problem

The 2026-09-23/24 CI campaign exposed a failure class no local gate could see:
vendor/test-asset materialization scripts that work in a dev tree but break
under CI's exact invocation shape from a fresh clone. Seven CI failures shared
it — a caller-relative mirror path in `ensure-dsh.sh` that silently missed on
CI, a quickjs vendor DIR decoupled from the pin suffix (a stale local leftover
made a dev tree pass while CI materialized a different directory, breaking the
harmony CMake on `dtoa.c`), `ensure_npm` double-prefixing ~180 full package
names into 404 bodies, a BSD `mktemp` interior-X template that turned the
second invocation into "File exists", and an iOS parity fetch list masked by a
hand-staged dev-tree copy. Every one of them is invisible from a dev tree by
construction: the dev tree has the vendor material already on disk, so the
ensure scripts short-circuit and nothing after the short-circuit is ever
exercised. Nothing in the DAG ran the scripts the way CI runs them — from a
cold checkout, from the repo root, with a relative path — so the class stayed
open until CI paid for it, seven times.

## Decision

**The vendor scripts' promise is proven, not trusted: a fresh-clone proof runs
in the default DAG on every PR, and the slow remainder on a weekly schedule.**

`runtime/spike/vendor/reproducibility-proof.sh` clones the current commit into
a scratch directory — vendor trees are untracked (D6), so that clone is
genuinely cold — runs the materialization scripts exactly the way CI calls
them (`sh runtime/spike/vendor/ensure.sh`, direct-exec
`runtime/spike/vendor/ensure-dsh.sh`, `sh runtime/spike/vendor/ensure-dsh-tests.sh`,
always repo-root cwd, relative paths), runs each a second time (the mktemp
class only fires on re-invocation), then verifies the result against the pin
tables the scripts themselves declare: every `name|ver|sha` row must exist as
a directory stamped with that row's digest — "the directory exists" is not
evidence, which is the upstream re-cut surprise — plus the engine artifacts
the platform builds include (`dtoa.c` is the file whose absence broke
harmony). The table parsing is derived from the scripts, not copied, so pin
bumps do not rot the proof; parse rot itself fails loud.

Two scopes, split on measured cost. `--gate` (ensure.sh + ensure-dsh.sh: the
engines, the mirror-served DSH closure — network-free, `dsh-tarballs/` is
tracked — and the 9 npm rows) runs ~2 min and is wired as the always-run
`vendoring-repro` gate via `gov gate add` (no `--paths`: the class fires with
zero code changes, because upstream re-cuts and deletes tarballs). The full
scope adds `ensure-dsh-tests.sh` — a ~25 MB codeload tarball plus a ~190-row
sequential npm leg, measured 13:49 cold — which is too slow for every PR; it
runs in the new scheduled/manual `.github/workflows/vendor-repro.yml`
(Mondays 05:23 UTC). The gate's rejection is proven twice: a corrupted pin in
a commit fails at the fetch layer (mirror digest mismatch falls through to the
deleted-on-master URL and dies loud), and a dropped stamp write fails at the
assert layer ("missing pin stamp").

## Alternatives considered

**Cache-first: keep CI's vendor caches and only assert on cached trees.**
Rejected — a cache hit is exactly the "material already on disk" condition
that hid the class; the proof's value is the cold path.

**Extend the tracked mirror to the engines and tests tarball so the whole
proof is network-free.** Rejected for now — it shrinks the proof's exposed
surface (the npm legs are where the double-prefix bug lived) and grows the
tracked tree by ~30 MB to save ~2 gated minutes; revisit if the scheduled run
flakes on network.

**Run the full proof in `gov.yml` on every PR.** Rejected on the measured
number: ~14 min against the gates job's 15-min budget. Signal per minute
splits better — the four failure modes that lived outside
ensure-dsh-tests.sh are covered per-PR by the gate scope, and the tests leg
is covered weekly.

**Hand-edit `gates.json` to add the gate.** Never — `gov gate add` validated
the entry, merged atomically, and the seal re-baseline is recorded in
`.gov/rituals.jsonl` naming T-0044 as the authority.

## Consequences

Every PR now pays ~2 network-touching minutes in the gates DAG; the DAG grows
to 15 gates. A cold proof can go red from upstream moving (tarball deleted,
package re-cut) with zero local changes — that is the point, and the failure
names the row. The weekly job's red needs a human to look at it: scheduled
workflows have no required-check teeth, so the escalation path is a process
note if it stays red, the same treatment the evidence matrix's accepted gaps
get.
