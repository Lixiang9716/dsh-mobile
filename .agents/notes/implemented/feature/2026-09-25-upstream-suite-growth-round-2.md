# Upstream-suite growth round 2: the `node:events` shim + the npm-bridges driver import

Status: implemented

Date: 2026-09-25 · Class: feature · Follows: the growth round 1 note of
the same day (testing class).

## Problem

Round 1's gap map named the head of the actionable queue: ~26 specs died
at module load on `no spike shim for node builtin 'node:events'` (the
ssh/subprocess/session/sdk source families link EventEmitter), and 7
specs died on `unmapped module specifier 'diff'` even though the diff
npm face is vendored AND bridged.

## Decision

- **`shims/events.js`** — the EventEmitter face: on/once/off/prepend
  variants, removeListener(s), emit with node's `error` special case (an
  unlistened error throws, never swallowed), the `newListener`/
  `removeListener` meta events (newListener emitted only when listened —
  recursion-safe), listenerCount/listeners/rawListeners/eventNames, max-
  listeners accounting; module-level `once(emitter, name, {signal})` and
  `getEventListeners`/`listenerCount` (EventEmitter instances only — an
  EventTarget's listener list has no inspectable surface here, loud).
  Deliberately NOT provided: the async iterator `events.on(...)`,
  captureRejections, EventEmitterAsyncResource — no import in this
  closure reaches them.
- Wired through every surface a shim touches: the host bare-map
  (`dsh_spike_host.c`), the iOS generator's explicit list, harmony's
  SPINE_OURS + `Index.ets` BUNDLE_FILES (android copies shims wholesale
  and its check finds them by find).
- **`upstream-suite-leg.js` imports `shims/npm-bridges.js`**: the bridges
  register at import time; the product boot imports them, the suite
  driver never did, so `diff` read as unvendored on the CLI leg. Fixed —
  the diff specs load (workspace-changes/compare went 3/3 green).
- The preset-family fixture staging and the zustand/eventsource-parser
  vendoring stay open (round 3): the latter needs lockfile version
  archaeology at the tag plus four subpath bridge rows
  (`zustand/middleware|shallow|vanilla`, `eventsource-parser/stream`) and
  a closure-policy nod for test-only npm faces.

## Alternatives considered

- **Vendoring a third-party events polyfill**: rejected — the face the
  closure imports is small and product-relevant (real plugins import
  EventEmitter); in-house keeps it on the shim table with the same loud
  contract as the other rows, and the closure stops growing third-party
  bytes for something this size.
- **Folding the npm-bridges import into the test harness instead of the
  driver**: rejected — the harness is the vitest replacement; the driver
  is the boot prelude, and "the driver registers what the product boot
  registers" is the invariant that matches the roles.

## Consequences

The sweep delta is measured in the round's PR. The map after this round:
`node:http` (~29 — a gateway-seam project), `node:child_process`/
chokidar/runner-launch (structural), npm test faces (round 3, policy).
