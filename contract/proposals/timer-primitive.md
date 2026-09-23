# PROPOSAL (draft — not frozen): `timer` primitives — a host-owned timer seam

> **Status: DRAFT for discussion.** This is a contract *proposal* under the D5
> discipline ("proposals start as an Agent Note citing D5 — never a drive-by
> edit"); nothing here is implemented, and `primitives.md` is untouched. If
> accepted, the shapes below become a `v1.4.0` additive minor
> (primitives.md §8) and this document is folded into it.
>
> Evidence base: the upstream DSH test suite (dsh-v0.1.6-alpha.2) on the
> Android emulator, round two of the gap-fill loop (2026-09-23) —
> 22 test failures across `agent-loop` specs fail with `setTimeout is not
> defined`, 2 specs hang awaiting turns that only a timer-armed abort would
> settle, and 100+ corpus specs are excluded at transpile time purely because
> fake timers / `vi.waitFor` / `expect.poll` presume a clock exists.
>
> English | [简体中文](timer-primitive.zh.md)

## The problem, stated without the solution

The runtime is a single-threaded coroutine host: JS runs on one serial queue,
host callbacks dispatch onto that queue (D2/D8), and **nothing in the system
can schedule a future callback**. That is a deliberate v0 boundary, and it has
a cost that is now measurable:

1. **Upstream packages call timers as a ambient global.** `@deepseek-ai/dsh-timeout`
   (deadline fuses, idle watchdogs for async iterators) and through it the
   agent loop call bare `setTimeout`/`clearTimeout`. On our host those names
   do not exist: every code path that arms a fuse throws `ReferenceError:
   setTimeout is not defined`, and every `await` racing such a fuse either
   fails or never settles (the two hang-class suite entries).
2. **The timer surface is a *capability*, not a polyfill.** A timer fires
   later, off the current turn — on this architecture that can only mean the
   host re-enters the runtime queue at a time of the host's choosing. That is
   exactly the shape the gateway exists to govern: an async primitive,
   permission-flagged, audited, dispatched onto the serial queue. Pouring it
   in as a `globalThis.setTimeout` would bypass negotiation and audit and
   would be unremovable later (a global is a frozen shape the day it ships).
3. **The shims already beg for it.** `node:timers/promises` is a stub whose
   functions throw "no timer seam in the spike runtime". A contract-level
   seam is what lets that shim (and only it) grow real behavior behind the
   same negotiation as everything else.

## Design constraints the proposal must honor

- **D2 (no threads on the runtime)**: the timer fires on the host; the
  callback is *delivered* onto the serial queue like every other host event.
  A timer never runs JS on a second thread.
- **D8 (event-driven)**: a timer is an event source, not a blocking sleep.
- **Contract-first (D5)**: nothing lands in a host before the table row is
  frozen; the shim layer may not invent host callbacks outside the gateway.
- **Additive minor (§8)**: hosts without the seam keep negotiating
  `gateway@1` and answer `unavailable`, exactly like `wasmRun`/`ishRun`.

## Proposed shapes (two rows, one flag)

### `timerSchedule(delayMs, opts?) → { timerId }` — schedule one wake-up

- `delayMs`: integer ≥ 0, **capped by the host** (dsh-timeout itself clamps
  at `MAX_TIMER_DELAY_MS`; the host may clamp tighter and says so in the
  rejection `reason`, it never silently truncates — rule 5).
- `opts.tag` (optional): caller-chosen audit tag. The audit trail must be
  able to answer "which plugin armed which timers" after a runaway.
- Resolves when the timer is **armed**, not when it fires. No callback rides
  the request/response — the wake-up is an **event channel** delivery (§
  event channels): `timer.fire { timerId, tag }`.
- `timerId` is an opaque integer; hosts guarantee uniqueness among live
  timers only (a cancelled-then-reused id is legal and auditable).

### `timerCancel(timerId) → { cancelled: boolean }` — disarm one wake-up

- `cancelled: false` for an unknown or already-fired timer (idempotent; a
  race between fire and cancel resolves either way, never both — the host
  picks one and the audit records which).

### Event channel: `timer.fire`

`timer.fire { timerId, tag }` is delivered onto the caller's serial queue.
One arm ⇒ at most one fire (no intervals in v1 — nothing in the vendored
closure uses `setInterval` semantics that a re-arm loop can't express, and a
stateless re-arm keeps the primitive minimal; revisit with evidence).

### Permission flag: `timer`

One flag gates both rows. Rationale: schedule-without-cancel is a footgun
(the suite's watchdog tests specifically cancel), and splitting them invites
half-capable hosts, which negotiation data couldn't distinguish usefully.

### What deliberately stays OUT of v1 of this proposal

- **No `Date.now()` alternative** — monotonic scheduling only; wall-clock
  needs (locale, ttl displays) are not timer fuses and belong elsewhere if
  they ever become gateway work.
- **No global `setTimeout`.** The mapping from `setTimeout`-shaped code to
  these primitives lives in the *shim layer* (`node:timers`,
  `node:timers/promises`, the spike's own seam), which negotiates the flag
  and fails loud when it is absent. A global would be a second, un-governed
  surface for the same capability — RFC 0002's lesson in miniature.
- **No drift/alignment guarantees.** The host fires "no earlier than
  `delayMs`" and makes no upper-bound promise beyond its own audit trail;
  tests needing exact timing stay on fake timers (excluded class).

## Why a primitive and not a plugin

The privileged layer owns cross-turn state by construction. A timer that
survives a turn boundary is definitionally host state (the runtime may be
torn down between arm and fire), so it cannot be plugin-served; and the
notify primitive already established that "wake me later" is host work. The
only new governance question is *which later*, and that is what the two rows
freeze.

## Conformance sketch (for the §7 table when this graduates)

1. negotiate `timer` → `timerSchedule(50)` arms; a `timer.fire` for the id
   arrives on the serial queue; ordering with queue-drain is: fire is
   delivered *after* the currently-running job completes (never reentrant).
2. `timerCancel` on an armed id suppresses the fire; on a fired id returns
   `{ cancelled: false }`.
3. an unaudited `timerSchedule` fails the audit gate like any unlogged call.
4. a host without the seam answers `unavailable` for both rows and never
   emits `timer.fire`.

## Alternatives considered

- **Polyfill a global `setTimeout` in the spike runtime.** Rejected: no
  negotiation, no audit, no permission gate, and a global surface can never
  be reclaimed once upstream code depends on its quirks.
- **Express timers as `notify` with an empty notification.** Rejected:
  notify schedules *user-visible* notifications (permission prompts, OS
  settings); piggybacking invisible wakes on it pollutes the permission
  story and the notification center on real devices.
- **Do nothing (keep excluding timer-dependent specs).** Rejected as a
  terminal state: the exclusion count is the largest single bucket in the
  upstream-suite manifest (100+ specs), and it hides real product surface
  (the agent loop's abort fuses) rather than proving it.
- **`sleep()` as a single primitive returning a Promise.** Rejected: a
  promise-only sleep cannot express "arm a watchdog, cancel it if the step
  finishes" without allocating a promise per arm; the suite's hang-class
  failures are exactly missing-cancel cases. Also, promise-only would force
  the shim to synthesize ids, re-adding state the host already owns.
