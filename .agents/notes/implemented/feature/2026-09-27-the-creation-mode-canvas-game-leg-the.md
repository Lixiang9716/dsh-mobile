# Agent Note: the creation-mode canvas game leg — the viewer's first rAF artifact

Status: implemented
Related: D5, D8

## Problem

The creation-mode loop (write + present → creation card → fullscreen viewer)
ended at static/CSS artifacts: the whale deliverable has no `@keyframes` and
no script, so nothing proved the viewer can carry LIVE, frame-driven content —
the baseline a game-engine direction (render surface, v1.7.0 candidate,
#226) stands on. An E2E leg had to establish it before any contract work
builds on it.

## Decision

`nextweb.mount` gains a second creation round on every host: after the whale
viewer closes, the drive sends `GAME_TURN 请做一个Canvas弹球小游戏`; the
scripted model writes + presents a dependency-free canvas game; the game card
is matched **by title** (the whale's card is still in the transcript — never
by position alone) and opened as the LAST card; the game's **heartbeat**
(`parent.postMessage` frame/beat counters — fixture evidence, not product
code, because the `sandbox="allow-scripts"` iframe is opaque to the parent)
must ADVANCE between two samples, so the verdict asserts the game RUNS, not
merely that it loaded. Both viewer closes settle honestly (open flips false
AND srcdoc cleared). Manifests go 19 → 24 on iOS and Android (committed
evidence 24/24 on both). The harmony leg pends on #230: the SECOND
`workspaceFiles/readAll` in one session never settles on the harmony bridge
(open stays true, no rejection toast, empty srcdoc; payload size ruled out
with a 945-byte fixture), so harmony's manifest keeps its 19 whale
expectations until that fix lands. Traps recorded for the follow-up: the game
turn's request body carries BOTH prompt markers, so `GAME_TURN` must be
matched before `CREATE_TURN` on every host; the card's textContent carries
icon + path, so matching is substring; a streaming re-render can swallow the
card click (the harmony leg retries the whole leg ArkTS-side, short page
invocations only — a long in-page loop starves the drive's own polling).

## Alternatives considered

- Asserting only the canary in srcdoc (load without execution): rejected —
  a loaded-but-throttled game would pass; the advancing-heartbeat assertion
  is the honest "it runs" fact (and it holds on iOS even with the driven
  WebView's throttled timers, via the fixture's setInterval beats).
- Driving the game from the drive side (evaluateJavaScript into the iframe):
  rejected — the sandbox (no allow-same-origin) makes the frame opaque by
  design; the heartbeat posts OVER that boundary, which is the assertion.
- A third tool-call round (edit the game, re-present): deferred — the
  two-round loop already proves creation+delivery+execution; editing is the
  next increment, not this leg's claim.
- Blocking the whole leg on the harmony readAll defect: rejected — per-host
  evidence moves at each host's pace; harmony's manifest rows land with the
  #230 fix (the registered-gap discipline).
