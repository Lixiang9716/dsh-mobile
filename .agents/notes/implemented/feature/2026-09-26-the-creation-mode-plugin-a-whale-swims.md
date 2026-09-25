# Agent Note: the creation-mode plugin — a whale swims across the phone

Status: implemented
Related: D9

## Problem

"Creation mode" needed its existence proof: a plugin completed on-device
end-to-end whose RESULT is visible on the phone screen — not another
transcript. The UI plane's pluggability (M3) had two proof clients, both
deliberately austere (amber monospace transcripts); nothing demonstrated
that a plugin can be a PRODUCT — a scene, an animation, a personality —
while still honoring the host contract.

## Decision

`presentation/web-client-whale` (`dsh-web-client-whale`): a third
self-hosted client whose page is a blue whale cruising a deep-ocean scene
— pure CSS/SVG (one SVG creature: body/belly/flukes/fin/eye/spout; CSS
keyframes for the 26 s cross-screen cruise, the bob, the fluke
oscillation, the spout, rising bubbles), zero dependencies, no build
step. It still speaks the FULL v0 contract — session-projection@0 over
`/ws` plus the toolbar slot ACK — and the whale reacts to the session:
token deltas spout bubbles, completion releases a pod. The transcript
rides in a corner glass panel so the page remains a real client.

Mounting reuses every existing seam, no new machinery: the embed joins
`WEBCLIENT_TREES` (the #214 tree whose suffix set admits html/css — the
accessor stages both plugin trees; rel prefixes keep them apart), the
selection switch gains `dsh-web-client-whale` → `webclient-whale`, the
carrier-side scenario flips to a new `whale.mount`, and the `/plugins`
combo row lists the variant. The mount E2E is the m2 session-mock-llm
drive with the whale selected — the manifest pins client.selected →
webclient.mounted → ws.connected (session-projection@0) → slot.registered
→ token-delta first/last → session-complete, 16/16 on the dsh-iphone
simulator (artifacts `hosts/ios/artifacts/whale-mount` + receipt).

## Alternatives considered

- **A system plugin (cordis) that draws** — the runtime has no canvas; the
  screen is the Web Client's, so the drawing must live in the presentation
  plane. A system plugin can only PROJECT events to it.
- **A skin over the official dist** — D6 forbids modifying the vendored
  bytes, and injection-row CSS cannot add a creature, only restyle
  upstream's DOM.
- **A native SwiftUI overlay** — strongest rendering, but it would bypass
  the pluggable-UI plane entirely: the point of creation mode is that
  plugins are web packages the host mounts by configuration.

## Consequences

Selection stays config-driven: `-dsh-web-client dsh-web-client-whale`
(the default client and all existing scenarios are untouched). The
`WEBCLIENT_TREES` list is now the one-line recipe for adding further
creation-mode plugins — drop a plugin dir, add a tree row, add the two
selection strings. The whale is also the on-device demo answer to "what
can a plugin look like": not a transcript, a product.
