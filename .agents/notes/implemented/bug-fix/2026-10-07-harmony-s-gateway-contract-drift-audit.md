# Agent Note: harmony's three gateway-contract drifts — audit wiring, unavailable semantics, descriptor honesty

Status: implemented

## Problem

The same-different matrix review confirmed three places where the
HarmonyOS host violated the frozen gateway contract (contract/
primitives.md) while its iOS/Android twins conformed:

1. **Dead audit code** — HostPhase.ets carried `auditSettleFn`/
   `micAuditLine` (the §6 structured audit) with ZERO callers:
   `onDispatch` handed every primitive a bare `settleFn()`, so not one
   gateway call ever produced a `dsh.gateway.audit:` record. §6 makes
   that audit mandatory ("for every call the host records primitive
   name, caller identity, permission verdict, and outcome code"), and
   test/e2e/scenarios/harmony-mic-plane-audit.json expects six records
   that never arrived.
2. **Wrong absence code** — gateway_smoke.cpp's fall-through answered
   every name it did not serve `invalid / unknown primitive`, including
   contract-KNOWN families this host simply lacks (fsStat/fsList/
   fsMkdir/fsRemove/fsRename, wasmRun, ishRun). Conformance §7 #1 says
   absence is information for negotiation, never faked: those names
   must answer `unavailable`, and the descriptor must declare them.
3. **Descriptor under-reporting** — BINDING_DESCRIPTOR did not list
   timerSchedule/timerCancel although onDispatch has served them since
   the timer seam landed, did not declare the absent families, and
   carried an orphan dead string (`'"unavailable":[]};'`) after the
   constant — a stale merge leftover compiling to nothing.

## Decision

- The audit is wired into the dispatch path itself: `auditedSettle`
  wraps every settlement the primitive modules make (one record per
  call: `{ts, primitive, caller, verdict, outcome}`, verdict granted
  for handler-routed calls with the settle code as outcome, denied for
  gateway-level refusals — the Android GatewayCore Done-wrapper
  semantics), `httpFetch.abort` audits without settling (dispatchAbort
  shape), and the mic rows keep the closed-vocabulary detail the
  capability-plane proposal's rule 4 names. The record rides the ONE
  phase sink via `hostCarrierLine` (never a direct hilog write — the
  single-writer capture rule), release-stripped like the Android/iOS
  cores. The dead `auditSettleFn`/`micAuditLine` were rewritten into
  this path rather than revived as-is (they encoded mic-only verdict
  semantics that would have mislabeled handler errors as `denied`).
- gateway_smoke.cpp answers the seven known-absent families
  `unavailable / not implemented on this host` through a
  `smoke_known_absent` check ahead of the `invalid` fall-through (truly
  unknown names stay `invalid`), and both descriptors (ArkTS
  BINDING_DESCRIPTOR + C DSH_BINDING_DESCRIPTOR) declare them.
- BINDING_DESCRIPTOR (both sides) now reports the timer pair it serves
  (26→28 available), declares the seven absent families (2→9
  unavailable), and the orphan string is gone. The canonical scenario's
  unavailable-set demand grew from PHASED_ROWS to the full
  honestly-declared set; six harmony manifests' `descriptor.declared`
  counts follow (28/9), including harmony-mic-plane.json which had been
  left at the pre-BLE 18/2.
- The OFFICIAL seat's descriptor is deliberately untouched: it is the
  narrow official serving face (8/3 — the timer pair since #395), names
  only what that seat serves or explicitly dropped from the v0 table,
  and nothing on it negotiates the absent families. Its stale manifest
  count (6 vs the scenario's demand of 8, latent red on main) is synced
  in the same branch.

## Alternatives considered

- Auditing inside `settleCall` with a "current dispatch name" field —
  rejected: settlements land on later ticks with several calls in
  flight; a field captures the LAST dispatched name and would mislabel
  interleaved settles. The name rides the closure instead.
- Emitting audit from C for the C-served app-scope fs calls too —
  deferred: the named gap (and its judge, harmony-mic-plane-audit)
  sits on the ArkTS dispatch path; the C-served rows remain unaudited
  and are called out as a residual gap for a follow-up.
- Adding the absent families to OFFICIAL_DESCRIPTOR's unavailable —
  rejected: that face never negotiates them; widening it would churn
  the httpfetch-streaming counts for no behavioral change.

## Consequences

The harmony audit stream shares the Android/iOS field set and
vocabulary (verified on-device: micStart granted/ok with the mic detail
vocabulary, timerSchedule granted/ok). Descriptor counts change for
every HostPhase seat, so the six manifests and the canonical scenario
demand moved together; the rawfile mirror was re-staged byte-verified
(vendor-official.sh --closure-only + check-bundle-files 1083/1083).

## Review round (same day)

Five review findings on the first pass, all taken:

- The mic audit manifests tripped on the micFrames idle window's
  timerSchedule/timerCancel rows (the #397 timer seam dispatches through
  the gateway; a healthy mic emits one armed/cancelled pair per consumed
  frame — count nondeterministic). check.mjs gained `extract.skip` (drop
  named records at extraction, invisible to the ordered walk and the
  nothing-extra check); the three mic audit manifests skip the two timer
  names; selftest.sh proves the fixture passes with skip, fails at the
  interleave without it, and still fails on a missing covered row.
- The not-covered dispatch arm (unreachable behind the parity gate)
  now mirrors Android's unknown-row vocabulary — audit denied/denied,
  settlement 'denied' — instead of denied/invalid.
- The smoke descriptor declares the seven absent families its own face
  answers unavailable (the answer/declaration gap had reopened on the
  regression face); the parity gate now enforces smoke-face coverage.
- host_start's descriptor read buffer grew 512 → 2048 — the 28-row
  descriptor sat at 511 bytes, one byte from an EINVAL phase start; the
  parity gate parses the buffer bound from napi_init.cpp and fails
  naming byte counts when a descriptor would not fit.
- The "byte for byte" parity claim is corrected to what holds: a shared
  field set and verdict/outcome vocabulary — the platforms' JSON field
  orders and ts precisions genuinely differ (the committed iOS
  device-plane artifact shows two field orders in its first two rows).
