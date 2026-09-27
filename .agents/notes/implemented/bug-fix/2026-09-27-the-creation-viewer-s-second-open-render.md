# Agent Note: the creation viewer's second open renders blank on ArkWeb — a fresh frame per open; the harmony game leg asserts the heartbeat

Status: implemented
Related: D8

## Problem

The canvas-game E2E leg (#231) failed on HarmonyOS with what looked like the
second `workspaceFiles/readAll` hanging: the viewer opened, the frame stayed
empty, no rejection toast. Escalating instrumentation (carrier request/settle
hilogs, a page-side direct fetch, a srcdoc write-read-back probe) cleared
every layer — the bridge settles in 1 ms with the right bytes, the page
resolves the RPC and decodes the game HTML — and the read-back probe showed
the real defect: **ArkWeb stops reflecting `iframe.srcdoc` after the frame's
first clear**. Writes succeed; the engine neither navigates nor reflects, so
the SECOND opened deliverable (any creation after the first per session)
renders blank on HarmonyOS — a real product bug a real device user would hit,
invisible on iOS/Android whose engines reflect srcdoc freely.

## Decision

`openCreation` in web-client-next now swaps in a FRESH frame node
(`cloneNode(false)` + `replaceChild`) before assigning srcdoc — a first write
on a new node is the path every engine handles. The harmony gameViewer leg
asserts the runs-proof through the fixture's HEARTBEAT (frame/beat counters
posted to the parent across the sandbox boundary) instead of the unreliable
srcdoc read-back: `game.opened` carries `heartbeatAdvancing: true`, and the
harmony manifest pins that host-appropriate fact (the canary stays a
diagnostic field). The runner's capture poll waits for the new terminal
record (`game.closed`). Result: nextweb.mount 24/24 on ALL THREE hosts with
committed evidence; #230's "readAll hangs" diagnosis is corrected — nothing
hung.

## Alternatives considered

- Keep asserting srcdoc on harmony (the iOS/Android assertion): rejected —
  it measures the engine quirk, not the product; the heartbeat is strictly
  stronger (it proves the deliverable's script EXECUTES).
- Recreate the frame only on harmony (hostType branch): rejected — the
  client is one copy (D6/D9); the fresh-frame swap is semantics-preserving
  on every engine and fixes real ArkWeb devices.
- contentWindow.location.reload() / document.write into the frame:
  rejected — sandbox="allow-scripts" with no same-origin makes the inner
  document untouchable from the parent by design.
