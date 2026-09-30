# Agent Note: the shim exposure map — the loader names every shim load, the survey reads the suite's blind tail

Status: implemented

## Problem

The repo's honest coverage story for the self-owned shim layer
(runtime/spike/upstream/shims/, 86 top-level modules) was anecdotal: the 681
upstream specs press the closure, but nobody could say WHICH shims a given
spec run actually resolves, or which of the 86 the suite never touches at
all. Classic line coverage cannot answer it either — the QuickJS runtime
admits no node coverage tooling — and an unmapped or orphaned shim rots
silently: exactly one such file existed (dsh-session-persistence.js, an
errors-only shim whose loader mapping the vendored-package harvest replaced,
leaving the file dead but still compiling). Without a load-level exposure
map, the thin tail stays invisible until a product path breaks through an
untested shim face.

## Decision

- **The switch** (`dsh_spike_host.c`): `DSH_MODULE_MANIFEST=<path>` in the
  process env makes the loader append one path line per resolved load under
  `upstream/shims/` — at BOTH channels shims ride: the ESM loader
  (`dsh_module_loader`, the 86 top-level modules) and the CJS bundle-read
  seam (`js_bundle_require`, the shims/sharp package internals). Default
  OFF: unset costs one getenv; append failures swallow (a diagnostic must
  never fail a load); no app or gate behavior changes.
- **The sweep** (`runtime/spike/ci/run-shim-exposure-sweep.sh`): every
  transpiled spec under the QJS leg with its own manifest (90 s cap, NO
  retry — a timed-out spec still contributes the loads it got), plus a
  harness-baseline leg (a nonexistent spec: the shims every leg pays before
  any spec body runs). Full run: 648 spec manifests, 8-way parallel.
- **The aggregator** (`tools/shim-exposure.mjs`): manifests in, per-shim
  exposure counts + the zero-exposure list out (`--json` for machines,
  `--baseline` to separate harness-fixed from spec-driven exposure).
- **The map, honestly read** (2026-09-30, main @ 41255786): the harness
  baseline alone loads 65 of 86 shims (globals/npm-bridges import
  eagerly), so LOAD-level exposure is nearly total: 85/86 exposed,
  **zero-exposure 1/86 — `dsh-session-persistence.js`**, which the C
  loader comment confirms is orphaned by design since the vendored
  dsh-session-persistence package took the mapping (2026-09-23 harvest).
  The informative tail is exposure BEYOND baseline: node-sqlite 3/648,
  openai-client/partial-json/slot-registry/dsh-client-ui-renderer-client
  5/648, source-bootstrap-loader-smoke 6/648, string-decoder 7/648.
  Boundary, stated plainly: a manifest line is a module LOAD, not a
  behavior press — the map locates the blind tail; the probes below press
  behavior.
- **The probes** (`scenario/shim-exposure-probe.js` + one-to-one manifest +
  `ci/run-shim-exposure-probe.sh`, the sixth core test leg): five legs on
  the real engine for the survey's riskiest faces by product path — the
  orphan's four error classes, node:sqlite `:memory:` round-trip,
  string-decoder's split-UTF-8 hold, partial-json's truncation ladder +
  openai-client's split-frame SSE and 401 shapes, slot-registry's
  boot-once/registration guards. Falsified per the testing rules: breaking
  string-decoder's tail-hold goes red (which ALSO exposed a swallowed
  async-leg verdict in the probe's own plumbing — fixed before green).
  Evidence: runtime/spike/artifacts/macos-cli-shim-exposure-probe/ (8/8
  one-to-one).

## Alternatives considered

- **Node-side istanbul/v8 line coverage over the shims**: rejected — the
  shims execute under QuickJS on the real engine; node-side numbers would
  measure different semantics and dress the map in a precision it does not
  have (the repo's standing boundary: node toolchain coverage does not
  reach QuickJS-executed faces).
- **A JS-side hook in cjs-loader.js instead of the C host**: rejected —
  the ESM channel (86 of the 86 top-level shims) is only visible in the
  C loader; a JS hook would see the CJS channel alone and miss every
  `node:*` load, while writing to the manifest from JS needs an fs seam
  the diagnostic should not depend on.
- **Recording EVERY module load, not just shims/**: rejected for scope —
  the vendored closure would make each manifest hundreds of lines of noise
  for a survey keyed on 86 names; `tools/check-staging-graph.mjs` already
  owns the whole-graph view.
- **Probing only the one zero-exposure shim**: rejected — a single-shim
  probe would imply the map's job is done while the 3–7/648 tail (sqlite,
  the LLM wire faces, the UI mount guards) stays unpressed; product-path
  risk, not the zero count alone, picked the five legs.

## Consequences

- The survey is reproducible from a clean tree: transpile → sweep →
  aggregate (the sweep script's header carries the three commands).
- Boot-verification-style self-tests stay the mechanism for on-device CI
  boots; the probe leg is the desktop-CLI complement and runs in
  `build/build.sh test core`.
- The orphan file now has a pin: if dsh-session-persistence.js is ever
  re-mapped or deleted, the probe leg is the tripwire that says which face
  moved.
