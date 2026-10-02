# Agent Note: carrier ws seats key per connection — the last-connection-wins teardown stops killing live pages

Status: implemented
Related: D9

## Problem

`CarrierServer.kt` held its WebSocket seats in `HashMap<String, OutputStream>` —
one seat per PATH. `upgradeSeat` closed the incumbent before registering the new
connection ("one seat per path"), so every new mux connection destroyed every
earlier one. The official mux client opens one physical socket per page, so with
two pages (or one page plus any second context — the exact shape the interactive
batteries drive): context B's connect closed A's socket → A surfaced
"Failed to load history: Remote stream WebSocket failed (gateway/internal)" and
flapped "Reconnecting…" while its maintain() loop reconnected, which closed B in
turn — a ping-pong where the newest page always won. A third face: `send` with no
live seat silently dropped the frame (`?: return`), so the surviving page's
session view stopped rendering journal events mid-turn while the turn continued
server-side, and the composer model trigger sat on "Loading models…" behind the
churning host generation. The iOS sibling never had the bug: it keys seats by
connection identity (`CarrierServer.swift` §3.3, `wsSeats: [ObjectIdentifier:
WSSeat]`, "multiple seats compose") — the Android port collapsed that to per-path.

## Decision

`seats` becomes `HashMap<String, MutableList<OutputStream>>` — a path holds one
seat PER live connection. `upgradeSeat` appends without touching incumbents and
registers only after the 101 handshake write; teardown removes exactly its own
seat (identity-checked) and fires `onWSClosed` only when the path's seat list
empties. `send` snapshots the path's seat list and writes to each, evicting
(hard-closing) only the seat whose write failed. `stop` closes every seat of
every path. The legacy `/ws` page seat inherits the same multi-seat semantics
harmlessly.

## Alternatives considered

- Client-side: serialize mux connections through a shared broker (one socket
  host-wide): rejected — the page-per-socket model is the upstream design and
  the carrier exists to serve pages, not to police them; the server holding one
  seat per connection is the contract the iOS build already proves.
- Keep one seat per path but queue/replay frames to the newest seat: rejected —
  it papers over the kill-the-incumbent behavior and still drops the older
  page's stream mid-session.
- Fire `onWSClosed` on every connection end: rejected — the callback means "the
  path closed"; wiring it per-connection would tear shared seat state on the
  first superseded socket (noted in the diagnosis as a live hazard for any
  future wiring).
