# Agent Note: the release sink strip covers every emitter (console shim + cordis exporter)

Status: implemented
Related: D5, D6

## Problem

The release log strip gated exactly ONE writer: `createLogger` in
`runtime/spike/logger.js` (the previous note, PR #83). Two other emitters sat
on the release path writing to `__DSH_LOG_SINK__` unconditionally:

1. the forwarding `console` installed by `runtime/spike/upstream/web-shims.js`
   — the shim that routes a JS `console.*` call into the unified sink, on the
   release graph through `scenario/b-android-web-live.js` →
   `upstream/web-boot.js` → `web-shims.js` (the traffic the user-facing
   Android release build actually runs);
2. the cordis logger exporter (`wireLogger`) in
   `runtime/spike/upstream/boot.js`, which maps a cordis record type to a
   level and writes it unconditionally.

The observed release output was still clean (0 records) — but only because
the vendored closure happened to contain zero `console.*` calls. The property
rested on upstream's continued silence, not on the flag: the "mechanism
exists only as text" class of defect. Measured rather than assumed: a release
CLI build driven through `console.log/info/debug/warn/error` emitted 5 records
(2×`info`, 1×`debug`, `warn`, `error`), and the pre-fix cordis exporter route
emitted all four levels. Both pre-fix captures are in
`runtime/spike/artifacts/release-logging/sink-route-rejection.release.txt`.

## Decision

The policy lives in exactly ONE place and every writer consults it.
`runtime/spike/logger.js` exports the critical set
(`RELEASE_CRITICAL_LEVELS = ['warn', 'error']`) and the predicate
`releaseKeeps(level)`; `createLogger` branches on the predicate for its
release shape, `web-shims.js`'s forwarder returns before writing when the
policy strips the level, and `boot.js`'s exporter computes the mapped level
and drops it the same way. warn/error never go through a stripping early
return: a distribution build keeps the critical set. The console's level
mapping is untouched (`log`/`info` → level `info`, `debug`/`trace` → `debug`,
`warn`, `error`) — the two `info`-mapped calls are dropped in release because
of their level, not their method.

`logger.js` is the home because it is already the file embedded
byte-identically into all three hosts and already the file where the release
mechanism is defined; a new module would have had to be added to iOS's C
arrays, Android's assets and Harmony's rawfile + `BUNDLE_FILES` — three
staging lists taught a 4-line predicate.

Evidence, because the guard is only real when it can fail: a new probe
(`artifacts/release-logging/probe/sink-probe.js`, run from the bundle root so
its routes ARE the canonical files) drives createLogger, the console shim and
the cordis exporter over a real `cordis` `Context`, one call per level, and
asserts per route that (a) a debug build delivers every level and (b) a
release build delivers warn+error only — plus that the OBSERVED kept set
equals `RELEASE_CRITICAL_LEVELS`, so the declared policy and the shipped
behavior cannot drift apart. `run.sh` asserts the per-route counts by name
and exits non-zero otherwise; `sink-route-rejection.release.txt` records both
the pre-fix leak and `run.sh` going red when one gate is deleted.

## Alternatives considered

- **Copy the flag check into each emitter** (`if (globalThis.__DSH_RELEASE__
  === true) …` × 3): rejected — this is the defect class being fixed. Three
  copies of a policy drift, and the next emitter someone adds starts
  unconditional; the console shim proved that.
- **A new `runtime/spike/log-policy.js`**: rejected — `logger.js` is already
  in every host's staging list; a new file would need iOS's `gen_bundle_header.py`
  RESOURCES, Android's assets, and Harmony's rawfile + `Index.ets`
  `BUNDLE_FILES` updated in the same change, i.e. three more places for the
  same four lines.
- **Derive `createLogger`'s release table from `RELEASE_CRITICAL_LEVELS`**
  (loop over the list, no-op the rest): rejected — `tools/check-logging.py`
  L4b pins the literal `debug() {}` / `info() {}` no-op shape that makes the
  strip visible at the source, and the probe now closes the drift gap that
  the literal table opens.
- **Map `console.log` to level `debug`** (so the four console calls land in
  four levels): rejected — the mapping is the shipped mapping; changing it
  would move debug-stream records for no behavioral gain, since a release
  build strips `debug` and `info` alike.

## Consequences

- `runtime/spike/logger.js` grows the policy (~10 lines) and every sink
  writer now depends on it; `wireLogger` is exported from `upstream/boot.js`
  so the evidence can drive that route without booting the whole spine.
- The release-logging evidence gains a third probe and per-route assertions;
  the MANIFEST carries the four-level table per route.
- Host copies stay byte-identical (`logger.js`, `upstream/web-shims.js`,
  `upstream/boot.js` in iOS's generated arrays, Android's assets and
  Harmony's rawfile): the invariant is unchanged, only re-materialized.
