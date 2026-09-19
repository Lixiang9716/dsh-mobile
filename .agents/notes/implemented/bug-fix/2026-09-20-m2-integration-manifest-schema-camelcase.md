# Agent Note: M2 integration: manifest schema camelCase fix, shim stream-key fix, simulator tap calibration

Status: implemented
Related: D5

## Problem

Landing the M2 real gateway binding surfaced three defects that blocked a green
batch: (1) `contract/schemas/manifest.schema.json` only accepted lowercase
capability names (`^[a-z]…`) while the frozen primitive table in
`contract/primitives.md` §2 uses camelCase flags (`fsRead`, `httpFetch`, …), so a
manifest declaring the nine primitives failed validation against the schema that
defines it; (2) `runtime/spike/gateway.js` resolved `httpFetch` body events by the
numeric call id while streams were keyed by the embedder's `bodyId` ("body:N"), so
streaming bodies never delivered; (3) the simulator tap driver
(`tools/e2e/run-ios.sh`) fired before the picker sheet presented and tapped
springboard icons while waiting for the notification banner, killing runs with
stray app launches.

## Decision

- Schema: the capability pattern now accepts camelCase
  (`^[a-zA-Z][a-zA-Z0-9.-]*(@[0-9]+)?$`). This aligns the schema with the frozen
  primitive table — a bug fix to one frozen document, not an evolution of shapes;
  no primitive, manifest field, or protocol changed.
- Shim: `streamEvent` falls back to the `body:<callId>` key
  (`streams.get(ev.callId) ?? streams.get(`` `body:${ev.callId}` ``)`) so bridge
  events (which carry the numeric call id) find their stream; the embedder
  tolerates both key forms.
- Runner: the picker leg waits for the sheet to actually cover the app
  (bottom-half screenshot-hash) before pressing, selects `notes.txt` with a
  ~0.15 s press (zero-duration taps never select on this runtime), and the
  notification-banner leg taps only after a top-strip hash diff proves the banner
  is rendering. `notify` schedules with a 5 s `UNTimeIntervalNotificationTrigger`
  so the banner exists after the driver backgrounds the app (an immediate
  trigger is consumed by `willPresent` and never reaches Notification Center).

## Alternatives considered

- Schema: change the primitive table to lowercase — rejected, the frozen table
  matches upstream DSH capability strings; the schema was the deviant document.
- Shim: key streams by call id everywhere (embedder change) — rejected, the
  embedder already shipped `body:N` semantics to the JS side and the shim owns
  the mapping between the two vocabularies.
- Banner: accept springboard icon taps during the wait window — rejected, they
  launched the Watch app mid-run and its permission alert poisoned later legs.
