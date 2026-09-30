# Agent Note: The weekly upstream-suite sweep joins GitHub Actions as a standing drift net

Status: implemented
Related: D9; the upstream-suite sweep program (notes 2026-09-25 bug-fix,
2026-09-28 testing); `.github/workflows/vendor-repro.yml` (the schedule +
materialization precedents this workflow copies)

## Problem

The full upstream dsh-tests sweep (`runtime/spike/ci/run-upstream-suite-sweep.sh`,
~645 transpiled specs × QuickJS CLI + Node reference) ran only when a human
remembered to run it locally — its two real catches (the 2026-09-25 shim
round; the TextDecoder product bug it surfaced inside that round) were
found by hand. Nothing periodic watched the suite: any shim, transpiler, or
runtime change that silently regressed the vendored-closure compatibility
story surfaced only at the next manual run, weeks later if at all. The
public-repo Actions free budget makes a weekly two-leg sweep cheap; the
sweep deliberately reports failure classes it cannot own (module-gap
families, 90s-cap claims), so its report — not its exit code — is the
product, and a gate-shaped CI job would be the wrong shape.

## Decision

`.github/workflows/weekly-sweep.yml` (new file; no existing workflow
touched) runs the full sweep weekly (Sundays 03:17 UTC — weekend, off the
hour, off the rush) and on `workflow_dispatch`, on `ubuntu-24.04-arm`
(the CLI's link embeds the iSH AArch64 static libs an x86_64 assembler
cannot build — the same constraint that puts quickjs-boot-parse on the
arm64 job). Materialization follows the gov.yml pattern verbatim: the four
vendored trees cached keyed on the ensure scripts' hashes
(`ensure.sh`/`ensure-ish.sh`/`ensure-dsh.sh`/`ensure-dsh-tests.sh`), then
materialized explicitly, then `npm ci` + `transpile.mjs` +
`parity-node-modules.sh` (the node reference leg's resolution layout), then
`host/build.sh`, then `run-upstream-suite-sweep.sh --paral 4`. The sweep
step is `continue-on-error` ON PURPOSE — a red result IS the finding — and
the summary step (`if: always()`) renders green/failed/NOSUM buckets with
spec names into the run summary, writes a JSON twin of the TSV, copies the
per-spec logs of every non-green row into a bounded artifact, and fails
loud ONLY on a missing/empty report (an infrastructure failure must never
read as a clean inspection). Report TSV/JSON/totals + failure logs upload
as one artifact (28-day retention).

## Alternatives considered

- **Gating the sweep (red CI on drift)**: rejected — the sweep's contract
  is to report failure classes it cannot own (module-gap families, CPU-
  contention 90s-cap claims, the node leg's differential answer); a red
  required check would block every PR on known-residual noise. The report
  is the deliverable; the run only vouches that the inspection ran.
- **Wiring the sweep into `gov run` as a product gate**: rejected for the
  same shape reason plus cost — the full two-leg run (645 specs, measured
  ~8 minutes on an arm64 dev machine, 2026-09-30) plus its toolchain build
  is far beyond the pre-push DAG's 15-minute budget; a weekly CI cadence,
  not the gate plane, owns runs of this size.
- **Running the sweep only on dispatch (no schedule)**: rejected — the
  standing net is the point; a dispatch-only leg is the manual status quo
  with extra steps.
- **Reusing the vendor-repro workflow's job**: rejected — that job proves
  the reproducibility proof's invocation shapes on x86_64, which cannot
  even build this CLI (iSH AArch64 link); the sweep needs the arm64 runner,
  the node toolchain, the transpile stage, and hours of timeout — a
  different job in every dimension that matters.

## Consequences

Drift against the pinned dsh-v0.1.6-alpha.2 suite now surfaces weekly
without a human in the loop, with the failing specs' logs attached. The
timeout (300 min) is budgeted from the local full-sweep measurement plus
cold-build headroom; a run that outgrows it loses that week's artifact and
the weekly cadence self-heals the next Sunday. Known first-run expectation:
the node reference leg currently dies loader-side on the `dsh:util-crypto`
import gateway.js grew in #254 (quickjs serves the scheme natively, the
Node smoke loader has no row for it) — the sweep reports that class
honestly as NOSUM rows until a follow-up maps it, which is the sweep doing
its job, not the workflow being broken.
