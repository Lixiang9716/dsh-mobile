# m5-primitives — HarmonyOS v2 host primitives evidence (M5 close-out)

One emulator run (`hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/m5-primitives`)
covering the three M5 open items as REAL primitives: httpFetch streaming over the
host's own loopback carrier, the HUKS keychain roundtrip, and the user-scope
DocumentViewPicker grant read back through fsScope persist/resolve. The binding
RuntimeDescriptor flips honestly to 9 available / 0 unavailable — every flip in
this run is backed by an on-device proof, not a declaration.

- Host: HarmonyOS emulator `dsh_phone` (127.0.0.1:5557, HarmonyOS 7.0.0 / API 26)
- Toolchain: HarmonyOS Command Line Tools 26.0.0.821, hvigor 6.26.4, SDK
  HarmonyOS 26.0.0 Release; unsigned debug HAP via `hdc install -r`
- Scenario: `m5.host-binding` — 27/27 expected↔logged, one-to-one, in order
  (verdict `dsh.spike.verdict: m5.host-binding PASS ... complete=1 pass=1`),
  plus the regression trio in the same launch (m1 7/7, m2.bridge 6/6, m2.session 23/23)
- Checkers: `verdict-*.json` (tools/e2e/check.mjs, all pass). The same launch
  also carries main's D9 official-web suite on the rebased architecture:
  b-harmony.official-web-mount 17/17, b-harmony.httpfetch-v2 6/6 (the D9
  proof leg rides the same HttpPrimitive.ets), b-harmony.session.live 43/43,
  b-harmony.write.live 33/33.

## Expected ↔ logged (manifest `tools/e2e/scenarios/m5-host-binding.json`
## vs capture `binding-capture.txt`, line = position in that file)

| # | expected event | capture line | note |
| --- | --- | --- | --- |
| 1 | carrier.listening | 1 | host-side (dsh.carrier) |
| 2 | webclient.mounted | 2 | host-side |
| 3 | ws.connected | 3 | host-side |
| 4 | gateway.negotiated | 5 | |
| 5 | descriptor.declared {available:9, unavailable:0} | 6 | the honest 9/0 flip |
| 6 | fs.write.ok {written:17} | 11 | C-served app scope |
| 7 | fs.read.ok {bytes:17, matches:true} | 15 | |
| 8 | fs.denied {code:'denied'} | 19 | ungranted `user:nowhere` scope |
| 9 | http.status {status:200, loopback:true} | 24 | loopback carrier |
| 10 | http.body {chunks:2, totalBytes:64} | 39 | streamed via http.body events (lines 26–38) |
| 11 | http.aborted {code:'cancelled'} | 51 | abort() after first chunk of /gateway-e2e/slow |
| 12 | picker.dismissed {null:true} | 77 | DocumentViewPicker close → resolves null |
| 13 | picker.granted {mode:'file', scopeOpaque, pathOpaque} | 80 | user scope `user:<uuid>` |
| 14 | fs.user.read {nonEmpty:true, matches:true} | 84 | seed bytes read through the granted scope |
| 15 | fs.scope.persist {refOpaque:true} | 86 | `bkm:<uuid>` in scope-registry.json |
| 16 | fs.scope.resolve {scopeOpaque:true, reads:true} | 91 | fresh `user:` handle, read-back matches |
| 17 | approval.approved {approved:true} | 94 | custom ArkUI dialog |
| 18 | keychain.roundtrip {set:true, match:true} | 99 | HUKS AES-256-GCM seal → open, bytes identical |
| 19 | keychain.deleted {gone:true} | 103 | keychainSet(ref, null) → get resolves null |
| 20 | notify.scheduled {idOpaque:true} | 106 | |
| 21 | app.state {state:'background'} | 109 | |
| 22 | notify.response {idMatches:true} | 112 | notification tap (wantAgent) |
| 23 | app.state {state:'foreground'} | 115 | |
| 24 | ws.token-delta {first:true, index:0} | 120 | host-side (dsh.carrier) |
| 25 | ws.token-delta {last:true, index:4} | 126 | |
| 26 | ws.session-complete {status:'pass'} | 127 | |
| 27 | scenario.complete {status:'pass'} | 128 | |

## Files

- `binding-capture.txt` — the binding phase capture (phase sink, app-side file
  pulled via `hdc file recv`; canonical `dsh.spike.log:` lines only)
- `sink-capture.txt` — regression trio capture (same launch)
- `logs.txt` — continuous `hdc shell hilog` stream filtered to `dsh.spike` lines
- `verdict-m*.json` — one checker verdict per scenario manifest
- `m5-live-deltas.png`, `m5-binding-complete.png` — human evidence only, never the assertion

## Design notes (see the agent note for the full record)

- httpFetch settles `{status, headers, bodyId:<callId>}` at headers and streams
  the body as `http.body`/`http.end` bridge events keyed by the numeric body id;
  the numeric id makes `abort()` real end-to-end (the abort seam parses the call
  id back out and `HttpRequest.destroy()` cancels the request). Loopback bodies
  that beat the settle are queued ArkTS-side and flushed after it.
- keychain: HUKS AES-256-GCM under a fixed-alias master key (generate-on-set on
  first use, load-on-get), sealed blob = 12-byte nonce + ciphertext(+tag) under
  `<filesDir>/keychain/<sha256(ref)>`. On this image `isKeyItemExist` THROWS
  12000011 for a missing key instead of resolving false; GCM decrypt requires
  the tag via HUKS_TAG_AE_TAG with the ciphertext body as inData.
- presentPicker: DocumentViewPicker (user scope); dismissal resolves null. The
  emulator image ships an EMPTY user store (no gallery, no documents) and is
  undebuggable (no shell seeding), so the binding phase bootstraps a seed file
  through the platform SAVE dialog (driver-tapped; unique per-run name — the
  dialog refuses duplicates) and delivers its name to the scenario as the
  `host.seed` bridge event. Creating new doc-provider files needs picker.save;
  the contract select surface is proven read-only, matching the Android twin's
  `m4.host-binding` (fs.scope.resolve reads:true).
