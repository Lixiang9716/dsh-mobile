# Agent Note: the perf.baseline leg and the leak.canary leg measure what the suite never did — plus the warn-tier trend gate that audits them

Status: implemented

## Problem

The repo's largest verification blank was performance and resources: no leg
measured how long a cold boot takes, how long a session turn or a
signed-catalog install commits takes, how many bytes the closures cost, or
whether 100 rounds of ordinary session churn comes back after a full
collection. The engine had ALREADY shipped one GC leak class once (the
decision-matrix wave fixed and re-pinned it — 678d99dc), and nothing would
have caught a recurrence: the upstream suite asserts correctness, never
reclaimability. Every gate that could have held a budget had no numbers to
hold.

## Decision

Three pieces land together (T-0087):

1. **The measurement face**: the spike host gains `__dshPerfProbe(mode)` —
   `JS_ComputeMemoryUsage` read, or `JS_RunGC`-then-read on `'gc'` — as a
   HOST TEST HOOK in the `__dsh*` family (like `__dshComplete`,
   `__dshLaunchEnv`). It never enters a gateway descriptor, the `contract/`
   freeze, or any capability table; scenarios call it directly. TEST
   INFRASTRUCTURE, review-checked.
2. **Two CLI legs** (each its own runner + one-to-one manifest + committed
   receipt, the house E2E shape):
   - `perf.baseline`: one cold boot, one mock session turn over the page's
     wire, the catalog refresh (the PURE-JS ed25519 verify's known cost,
     ~5s) and install commit. D8: every number rides the scenario's own
     event stream; the runner extracts them into the receipt and adds the
     shell-side facts (spawn→PASS wall clock; SpikeBundle.c regenerated —
     gitignored build output since the D9 flip; dsh-fs tgz, fixed TEST
     seeds, deterministic bytes). Wall-clock numbers are FLEET-NOISY on this
     shared box — coldBoot measured 28/190/99/452ms and turnMs 18/252/137/180
     across four runs — which is exactly why the budgets are warn-tier
     with order-of-magnitude margins; the recorded baselines are the final
     committed run (coldBoot 452ms, turn 180ms, refresh 5207ms, install
     626ms, spawn→PASS 7612ms, bundle 68,052,388B, tgz 6,656B) — the same
     numbers baselines/perf-baseline.json and the committed receipt hold.
   - `leak.canary`: 100 mock session rounds, heap watermarks BEFORE and
     AFTER a forced collection, collected-vs-collected. MEASURED natural
     growth: **+8,347,650B** (byte-identical across FOUR independent runs)
     (session records are lifetime maps BY DESIGN —
     `ctx.sessions`/`ctx.agents` keep a session's log outlives its turn —
     plus engine atom/shape ratchet). Tolerance = 16 MiB ≈ 2x natural, and
     the first canary draft's guessed 1 MiB tolerance went red on this exact
     lesson: the honest number came from running, not estimating. Jitter is
     tiny: every independent run measured the SAME growth to the byte.
3. **The trend gate**: `tools/check-perf-budget.mjs` audits the two
   committed receipts against `baselines/perf-baseline.json` (8 metrics,
   each {receipt, path, baseline, warnAbove}); missing receipt/number fails
   loud. Warn-tier (`allowFailure: true`) + hand-added `needs:[self-test]`
   per the #244 serialization edge — the same wiring the coverage-floor gate
   ships (#274). Rule-6 case `.gov/rejections/case-perf-budget.sh`
   (sandboxed `--budgets`/`--artifacts-root`): margins below baseline → all
   8 red + named; missing receipt → fail-loud; real receipts → green. Plane
   re-sealed with the reviewed-change reason in the ritual ledger.

**Falsification (both teeth, real outputs, this branch)**:

```
# leak.canary, one retained 1MB array per round (temporary probe, reverted):
{"event":"leak.canary.verdict","status":"leak","rounds":100,
 "beforeMemoryUsedSize":9438282,"afterMemoryUsedSize":227511620,
 "growthBytes":218073338,"toleranceBytes":16777216}
GATE-EXIT(red)=1        # restored byte-identical → 6/6 green, exit 0

# perf-budget, every margin pressed below its recorded baseline (sandbox):
perf-budget: FAIL: boot.coldBootMs: measured 28 > margin 27 (baseline 28)
  … all 8 metrics FAIL …   GATE-EXIT(red)=1
# restored: perf-budget: all measured numbers within their warn margins
GATE-EXIT(restored)=0
```

## Alternatives considered

- **A gateway primitive for heap readings** (e.g. a `perfProbe` capability
  row) — rejected: measurement is not a product capability; a descriptor row
  would freeze a test face into the contract and force every host to serve
  it. The host-global hook keeps the gateway frozen (D5) and still serves
  every CLI leg; a device-host face can add its own equivalent hook later
  without a contract change.
- **Pin the measured numbers in the e2e manifests** — rejected: they jitter
  by nature and machine; the manifests pin events + stable fields only, the
  numbers live in receipts and the baselines file. Deterministic logs stay
  deterministic.
- **Threshold the canary at "post-GC must equal pre-GC"** — rejected: it
  measured +8.3MB on 100 perfectly healthy rounds (by-design residency);
  that gate is red forever, which is a vacuous gate, not a strict one.
- **Budget gate re-runs the legs itself** — rejected: minutes of CI per push
  for numbers that change slowly, and CI would then own machine-specific
  margins. The gate audits COMMITTED evidence (the office-plane lesson's
  audit shape); the runners are the re-run.
- **First-version budgets blocking** — rejected: one machine, one run.
  Warn-tier records red without blocking; margins tighten as more machines
  confirm.

## Consequences

The baselines file is now a status surface: re-record it only together with
fresh receipts (both sides in one change), and note the machine. The
canary's tolerance carries its provenance comment in-scenario; a future
engine re-pin MUST re-run both legs before landing. Known residue, honest:
the growth number's stability is measured on ONE machine (four runs, byte-
identical); cross-machine margins are exactly what the warn tier waits for.
