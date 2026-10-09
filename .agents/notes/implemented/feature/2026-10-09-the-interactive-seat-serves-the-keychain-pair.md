# Agent Note: the interactive seat serves the keychain pair — BYOK onboarding lands on the official seat

Status: implemented
Related: T-0209, #424 (the deferred-settle discipline), #76 (HostPhase's HUKS keychain)

## Problem

The official serving seat declared `keychainGet`/`keychainSet` unavailable
(OFFICIAL_DESCRIPTOR's unavailable list), so the BYOK round's first
persisting step failed loud: `onboarding/save` seals its credential through
`keychainSet` and a saved route resurrects at boot via `keychainGet`
(upstream/llm-route.js `decodeCredential`), and with the pair unavailable
every one of those calls answers a gateway error. The seat already had
everything else the flow needs — the runtime modules, the carrier, the
httpFetch transport — only the seat-side primitive wiring was missing.
(Device-verified 2026-10-09 with this wiring applied: onboarding/status →
save → status `byok {openai-compatible, bigmodel, glm-5.3-flash}`, then
real streaming rounds over the saved credential.)

## Decision

`OfficialServe` serves the pair in HostPhase's exact form: a
`KeychainPrimitives` field constructed at `startRuntime` with the ability's
`filesDir` (the same HUKS AES-256-GCM sealed blobs the binding drive
serves), and an `onDispatch` branch forwarding `keychainGet`/`keychainSet`
to `get`/`set` with a settle closure. The descriptor moves the pair from
unavailable to available — 13 available / 1 unavailable (`presentPicker`
stays the only honest absence; the comment's previous "8 available" had
also missed #424's surface trio, so the counts now name every row with its
landing PR).

One deliberate deviation from the device-run form, found in review:
the settle closure is DEFERRED one event-loop turn (`setTimeout(0)`), the
same shape as the seat's timer and surface branches. The as-run form
called `hostSettle` synchronously on the theory that KeychainPrimitives
always settles from a later tick — false on three faces: an unset-ref get
answers `'null'` synchronously, a delete set answers `'{}'`
synchronously, and malformed args reject synchronously (an async body
runs to its first await). The fresh-install status detect and
`onboarding/clear` both ride those faces, and a `hostSettle` re-entered
from inside the C dispatch callback throws — measured 2026-10-09 on this
seat (every timerCancel dispatch failed with `on_dispatch callback
failed`, gateway_smoke.h: "never re-enter the runtime"). The deferral is
invisible to the device-verified paths (their settles already arrive from
HUKS promise continuations, one turn later than before at most) and
closes the re-entry hole on the synchronous ones. HostPhase's immediate
`auditedSettle` is unchanged: its keychain settles arrive from the same
async faces, and its discipline is a separate decision for that seat.

## Alternatives considered

- Landing the as-run form verbatim (no deferral): rejected — it preserves
  a first-boot landmine the seat's own sibling branches already paid the
  measurement for; the deferred shape costs one turn on paths that are
  async anyway.
- Deferring inside KeychainPrimitives (wrapping its sync settles):
  rejected — it would change the module every OTHER seat shares
  (HostPhase's binding drive) and hide the seat-specific dispatch rule in
  the wrong layer; the re-entry constraint belongs to the seat that owns
  the `hostSettle` boundary.
- Serving the pair through a new gateway seam: never considered — the
  primitives are frozen contract v1.0.0 rows; this is seat wiring, not a
  contract change (D5 untouched).
