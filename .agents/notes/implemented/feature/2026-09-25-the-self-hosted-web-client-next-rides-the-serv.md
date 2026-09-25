# Agent Note: the self-hosted web client rides the serving seat

Status: implemented
Related: D6, D9, D15

## Problem

The mobile UI plane had two faces: the v0 in-house clients (`dsh-web-client`,
`dsh-web-client-mini`) speak a read-only projection (`/ws`,
`session-projection@0` — no prompt admission, no RPC) and render an amber
debug transcript; the official upstream dist (v1, D9) is the full product UI
but is vendored verbatim, so its look and interaction cannot change by one
byte (D6), and its desktop-first information architecture only tolerates the
phone through carrier-side injection CSS. A mobile user-facing redesign had
exactly two bad options: fork the official dist (D6 violation), or grow the
v0 projection into a write surface (a second, divergent UI wire).

## Decision

A third client, `presentation/web-client-next` (id `dsh-web-client-next`),
that owns its UI and rents the OFFICIAL plane: it speaks the Phase-B carrier
surface (`POST /api` envelope bridge + `WS /api/remote.mux`) — the same
frozen envelope the official dist speaks — so session/create, prompt
admission, live journal streams (baseline + change + assistant-stream
frames), and every future runtime claim arrive without a new wire. The UI is
ours: the clarklevis design language (deep-ocean palette, glass surfaces,
user bubble vs full-width assistant, collapsible reasoning/tool groups,
cached markdown, send/stop composer), vanilla ES modules with no build step,
each file under the code-size gate.

Mounting reuses the serving seat instead of adding one: `SessionServe`
already serves a dist over the /api+mux routes; when the launch
configuration selects `dsh-web-client-next` (iOS `-dsh-web-client`), the
seat swaps the dist root to the staged plugin and serves ZERO injection
rows — the ModuleLoader facade, boot graph, recovery global, and phone CSS
are the official page's boot machinery, and our page boots from its own
modules. The official dist remains the default selection, so every existing
scenario's boot bytes are untouched. The client rides the iOS embed as its
own tree (`dsh_spike_webclient_tree_file`) because the spine tree's suffix
filter (js/json/...) would silently drop the html/css — the 2026-09-24
silent-drift class, refused at the generator (fail loud on a missing tree).

Desktop iteration rides `tools/dev-web-carrier --client next`: the fixture
carrier serves the page and answers session/list/create/prompt/cancel with
a labeled dev-echo turn (canned markdown + a tool card, streamed through the
real mux frame shapes), so CSS/layout loops stay at ~0.5 s instead of an
emulator cycle. The E2E is `nextweb.mount` (iOS): the probe drives OUR page
like a user (new session → type → send) through a real agent-loop turn over
the scripted model boundary, and the manifest pins the page's own wire facts
(index.rendered rows=0 → asset /js/main.js → mux upgrade → session/follow
attach → composer typed → journal frames forwarded → page.rendered with the
scripted reply in the DOM).

## Alternatives considered

- **Inject a reskin into the official dist** (more carrier CSS/JS rows) —
  keeps the official UI's DOM as the thing we style against: every upstream
  re-pin can shuffle hashed classes and silently break the skin, and the
  interaction ceiling (navigation, viewport, composer behavior) stays
  upstream's. Rejected; injection rows remain for phone LEGIBILITY fixes,
  not for a redesign.
- **Grow the v0 `/ws` projection into a write surface** — a second UI wire
  parallel to the official one: every runtime claim would need re-exposing
  in a new dialect, and the "official plane parity" the Phase-B carrier
  already proves would not transfer. Rejected.
- **A native SwiftUI chat viewport (the clarklevis route itself)** — the
  strongest end-state (ChatLayout-grade virtualization, Live Activity
  approvals) but a new platform surface with its own whole proof burden;
  the web client is the architecture's swappable-UI seam and is
  cross-platform by construction. Deferred — the timeline fold and item
  vocabulary here are deliberately the portable subset of that design.
- **Serving the client through a separate seat** — a second server beside
  SessionServe would fork auth, the bridge, and the mux wiring. The flavor
  switch on the one seat keeps one serving path the user-facing launch and
  the E2E both run.

## Consequences

The client is default-OFF (the official dist stays default), so nothing
user-visible changes until the launch configuration (or a future profile
patch) selects it. The stop button sends `session/cancel`, which the mobile
runtime does not claim yet — the page surfaces the structured refusal as a
toast (honest, never faked); claiming that endpoint is the natural next
runtime surface. Android and HarmonyOS mounting (their hardcoded client
paths and harmony's BUNDLE_FILES rows) is the follow-up port. The dev
carrier's echo turn is fixture behavior, labeled as such in the turn
content — it is an iteration tool, not an oracle (CI stays log-based).
