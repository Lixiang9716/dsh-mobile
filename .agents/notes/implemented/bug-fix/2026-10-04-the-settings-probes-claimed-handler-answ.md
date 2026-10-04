# Agent Note: the settings probes' claimed handler answers — the probe waiter yields to the host looper

Status: implemented

## Problem

On the serving seats (Android SessionServe — the release cockpit and the
next-web debug seat) every spine boot failed with `no api.respond for the
probe/pluginInventory-list-1 probe`, and the FAIL line churned the whole
logcat buffer: 14,037 lines in the battery round's buffer, ~1.4k/10min in
bursts exactly while a cockpit page was connected. The E2E-by-logs vehicle
was persistently red on the real seat, and the churn broke whole-buffer
marker greps. The plugins themselves worked (the page's own plugin data
arrives through the carrier bridge), so the probe mechanism, not the panel,
was broken.

Two stacked defects, neither visible in CI (the composer.live-write leg's
recorded evidence predates the regression; the serving seat was never
re-driven):

1. **The waiter starved the handler it waits for.** #334 (faff3a4d) gave the
   `pluginInventory/list` handler its first GATEWAY await — the workspace
   registry tier reads `spike/plugins/registry.json` through `fsRead`
   (web-write-inventory.js:141). On the device embedders a gateway settle is
   queued on the runtime looper (SpikeRuntime.post) and only lands when the
   JS job queue empties and the native pump returns. The probe waiter
   (composer-web-live.js awaitRespond) spun `await Promise.resolve()` — pure
   microtasks never empty the queue — so a correct handler starved and the
   demand fired. Live trace (debug SessionServe build): the two registry
   fsReads issue, the 5s wait expires, the scenario completes-fail.
2. **The failure multiplied.** `demand` calls `fail()` then throws;
   `main().catch(fail)` emitted a second verdict; and the m4 status check
   reads the sticky completed flag (dsh_spike_m4.c m4_status), so EVERY later
   bus crossing re-reported completed-fail — SessionServe logged the FAIL per
   page frame. A bonus defect surfaced on the first honest re-drive:
   composer-web-live never dispatched `probe/pluginManager-listPlugins-1`,
   which the shared manager-legs probe (a3e35d72, #340) awaits — a probe
   awaited but never dispatched waits forever.

## Decision

- **The waiter yields to the host** (scenario/probe-respond-await.js, split
  from composer-web-live.js): each poll tick is a minimal gateway call
  (`fsStat('app', 'probe.txt')`) whose own settle queues on the same looper
  as the settles being awaited — awaiting it hands the looper its turn, the
  earlier settles land, and the respond is found. A wall-clock deadline
  (5s) keeps a genuinely dead handler fail-loud, with the waited-facts in
  the message; a boot with no gateway keeps the historical microtask budget
  verbatim. The handler contract (async, args unwrapping, union shape) is
  untouched — this fixes the AWAITER, so every claimed probe answers
  in-band (data or the structured error the deliver legs already post).
- **One verdict per scenario**: `fail()` is first-only (the demand throw no
  longer double-emits through `main().catch(fail)`).
- **One FAIL per seat**: SessionServe.fail returns early once
  `runtimeFailed` is set — the resident runtime re-reports completed-fail
  per crossing; the first reason names the cause.
- **The missing probe is dispatched**: `pluginManager/listPlugins` joins
  SETTINGS_PROBES, matching what the shared manager-legs probe awaits.
- Panel (209/209): the waiter finds late responds (the starvation
  regression), fails loud naming the probe at the deadline, keeps the
  gatewayless budget; the claimed handler answers the frozen three-tier
  union shape and refuses loud on broken providers. Live proof on the debug
  SessionServe seat: ZERO FAIL lines, all four probe records emitted
  (roster, inventory, manager readonly) where the pre-fix build burst FAIL
  lines per frame.

## Alternatives considered

- Wire the timer seam into SessionServe and yield via setTimeout: the shim's
  arm failure only surfaces as an unhandled rejection, and the serving seat
  never wired `timer.emitFn` — the first measured variant hung SILENTLY
  (worse than the loud failure). The gateway ping needs nothing the seats
  don't already prove at boot (every settle path is wired), and it works on
  all three hosts that serve this scenario.
- Bound the handler (timeout inside the workspace-registry read): treats the
  symptom one layer down, leaves every FUTURE gateway-awaiting claimed
  handler starved by the waiter, and a timeout would be a second clock in a
  system whose rule is wait-on-conditions.
- Dampen the C host's status re-report (dsh_spike_m4.c): cross-embedder
  contract churn; the Kotlin fail-once guard achieves the log hygiene with
  three lines in the seat that storms.
