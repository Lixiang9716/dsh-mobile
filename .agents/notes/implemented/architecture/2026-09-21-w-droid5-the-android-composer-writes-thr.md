# Agent Note: W-DROID5: the Android composer writes through the on-device spine — the session write surface (b-android.write.live)

Status: implemented
Related: D9 (upstream port); the Android sibling of W-RPC (#65,
b4.write.live); completes the write leg W-DROID4 (#66) left as the named
gap; contract docs/webserver-contract.md §2.3/§2.4

## Problem

The Android host had the read path live (b-android.session.live 46/46:
session.list + the mux session/journal answered from the on-device spine),
but the official UI's WRITE surface still answered structured-unavailable:
a composer message typed in the official upstream web app (rendered in the
Android WebView) could not produce a session. `session/create`,
`session/prompt`, the settings legs, and the `session/follow` /
`workspace/follow` / `session/control` / `$events` mux streams the page
needs to drive and observe a turn were unclaimed — the write path stayed
Android's named D9 gap after #66, while iOS already had the product moment
(#65).

## Decision

- **The write composition is platform-neutral and already existed.**
  scenario/b-android-write-live.js is the b4-web-live sibling: the FULL
  spine boots on ONE ctx (upstream/boot.js) and the web-boot producer
  mounts the official wire COMPOSED WITH the write surface
  (upstream/web-write.js + its streams + settings legs, mirrored from the
  vendored client faces at the pin). The runtime NEVER prompts: the page's
  own composer message admits a real upstream agent-loop turn
  (`source:{kind:'user', rpcId}`), the scripted /mock-llm/chat/completions
  carrier endpoint stays the model boundary (real loopback HTTP + SSE, only
  the model output scripted, logged as such), and the reply streams live
  over the mux journal back into the official DOM. Only Android transport
  facts differ: `runtime.booted` emits `entryCount` (logcat's ~4KB line
  budget), and the scenario id/identity.
- **The write layer rides the tracked port layer.** assets/spike
  (the Android embed) gains web-write.js / web-write-streams.js /
  web-write-settings.js + the current web-boot.js and settings-memory.js as
  byte-identical tracked copies (the #63 discipline for the port layer);
  stage-spine-closure.sh now copies the write scenario too, and its
  byte-identity verify actually fails the build now (the drift markers
  collected in a temp file — the previous pipeline `while` loops ran in
  subshells, so the `fail=1` never reached the parent shell and the verify
  was vacuous).
- **The probe drives the REAL UI like a user** (SessionWriteProbe +
  SessionWriteSession, Kotlin siblings of the iOS pair): dismiss the
  welcome notice, click the workspace chip, pick the seeded workspace row,
  type into the real Lexical composer (caret placement + execCommand
  insertText, value-verified with bounded retries), click the send button.
  Legs post their JSON through the `dshProbe` JavascriptInterface with a
  `leg` tag (the WebView cannot await a Promise); SessionWriteSession runs
  pick → type → send in order and fails loud on any unmet leg. The send
  leg first posts a pre-send snapshot (`composer.ready`: the message still
  in the composer with the notice dismissed — the re-rendering welcome
  modal would otherwise photobomb the typed-composer screenshot) and its
  value is re-verified against the typed text before the click.
- **Determinism by construction, not by freeze-and-pray.** Three timing
  hazards were removed at the source before the manifest was frozen: the
  diagnostic raw `session/follow` subscriber attaches only AFTER the reply
  has rendered (an early draft attached as soon as the session id appeared
  and captured a timing-dependent mix of live frames — 12 or 13 — run to
  run); the page session's id is resolved from the REAL session.list RPC
  (the minted `session-<uuid>` shape — the runtime agent's configured id
  is a different shape), not from the DOM text, which does not reliably
  render it; and the seam holds EVERY first-call RPC witness (forwarded
  and unavailable alike) and flushes them SORTED at the drive's finish
  marker — even the forwarded session.list/session/create pair raced both
  orders across runs. Post-flush stragglers emit individually (never
  silently dropped). The frozen b-android.write.live manifest (45 events)
  passed three consecutive identical-verdict runs before freeze.
- **Shared row mapping.** CarrierIndexRows extracts the `web.boot` rows →
  injection-rows mapping (identical in three drive sessions) so the new
  session file stays under the code-size gate (500 lines).

Canonical run: b-android.write.live 45/45 with the full regression green in
one invocation (m1.spike.boot, m2.bridge.smoke, m2.session, m4.host-binding
35/35, m2.gateway.audit 16/16, b-android.official-web.mount 14/14,
b-android.session.live 46/46). REAL screenshots (boot, composer typed via
the pre-send snapshot, reply rendered) under
hosts/android/artifacts/android-write-live/.

## Alternatives considered

- **Reusing SessionLiveSeam for the write drive**: rejected — its flush
  point (first forwarded call) and its session.list.responded /
  session.attached observers are the b-android.session.live manifest's
  shape; retuning it in place would have churned a frozen 46/46 manifest
  the write drive does not need. A dedicated SessionWriteSeam keeps both
  manifests stable.
- **Keeping the mid-turn diagnostic attach (richer frame evidence)**:
  rejected — the frames count depended on when the session id first
  rendered in the DOM (12 vs 13 frames across runs); a timing-dependent
  manifest is a flake factory. Liveness is proven by the runtime's turn
  events and the rendered reply, not by the diagnostic subscriber.
- **Keeping the iOS manifest's inline forwarded-RPC order**: rejected —
  three runs pinned session.list before session/create, the next binary
  flipped the pair; the page fires its bursts in parallel and the emulator
  does not reproduce the iOS device's interleave. The sorted finish flush
  (the session-live discipline, extended to forwarded calls) keeps every
  witness with a deterministic order.
- **Driving the composer with uiautomator/input taps** (the m4 native-UI
  pattern): rejected — the composer is a rich contenteditable inside the
  page; same-origin JS drives it with real pointer/input events AND reads
  the true rendered state in one place, which the shell-side tap pattern
  cannot observe. The uiautomator pattern stays for NATIVE dialogs.
- **Pinning the page's locale-dependent notice facts**: kept minimal — the
  emulator locale is fixed (en), so `dismissed`/`notice` are stable; the
  minted session id, plugin rev, and page bodyText stay unpinned by
  design.

## Consequences

- The D9 product moment now holds on BOTH mobile hosts: a composer message
  typed in the official upstream UI produces a real upstream agent-loop
  turn whose reply renders back in that UI, with the workspace picker,
  settings describe/mutate, and the session control + event-stream
  handshakes the page's boot needs.
- Still structured-unavailable (named, unchanged from #65): the
  dynamicCordisRunner inventory/inspect surface, credentials, model
  catalog, agent presets, permission presets, subagents/commands/skills/
  terminal/llm listings, and the forwarded-event payload beyond the ready
  handshake.
- stage-spine-closure.sh's verify is now load-bearing: a future re-pin that
  drifts from the runtime bundle fails the Gradle build loudly.
