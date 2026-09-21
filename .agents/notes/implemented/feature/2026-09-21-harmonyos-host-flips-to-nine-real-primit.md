# Agent Note: HarmonyOS host flips to nine real primitives: streaming httpFetch, HUKS keychain, user-scope picker

Status: implemented
Related: D5, D8

## Problem

The HarmonyOS binding host (M5) declared
`"unavailable":["presentPicker","keychainGet","keychainSet","httpFetch"]` —
an honest v1, but a conformance gap (contract §7 expects all nine primitives
or an honest declaration; negotiation data on this host was 5/4 while the
Android twin already ran 9/0). The three gaps map to real platform needs: an
LLM stream on this host is impossible without a streaming-response httpFetch
(D8 — one event sequence, never a blocking whole-result), credentials have no
home without keychain, and user files are unreachable without a picker grant.
Each also needed an on-emulator proof before the descriptor could flip —
flipping first would be faking availability (§7, ARCHITECTURE.md §12).

## Decision

- **httpFetch** (`model/HttpPrimitive.ets`) over `@ohos.net.http
  requestInStream`: the call settles `{status, headers, bodyId:<callId>}` and
  the body streams onto the runtime queue as `http.body` chunk events
  (≤4 KB raw, base64 — sized to the 8 KB `hostEvent` bridge buffer, which was
  raised from 2 KB) plus a terminating `http.end`; failures after the settle
  ride `http.error` with a GatewayError code. The bodyId is NUMERIC (the
  gateway call id) so the bridge's abort seam — which parses an int32 out of
  it — round-trips: `abort()` reaches `HttpRequest.destroy()` for a real
  host-side cancellation, not just a shim-side stream cancel. Loopback bodies
  that beat the settle are queued ArkTS-side and flushed after it, so JS
  always observes settle → chunks → end. The carrier grew `/gateway-e2e/bytes`
  (2×32 B) and `/gateway-e2e/slow` (6×16 B paced 300 ms) chunked routes.
  Proven against the host's own loopback carrier — no external dependency.
- **keychain** (`model/KeychainPrimitives.ets`) over `@ohos.security.huks`:
  AES-256-GCM under the fixed alias `dsh-keychain-master` (generate-on-set on
  first use, load-on-get, never extractable); the sealed blob — 12-byte random
  nonce + ciphertext with the GCM tag appended — persists app-private at
  `<filesDir>/keychain/<sha256(ref)>`, the KeyRef never becoming a filename.
  Unset refs resolve null; `keychainSet(ref, null)` deletes. Two image quirks
  are handled and documented: `isKeyItemExist` THROWS 12000011 for a missing
  key instead of resolving false, and GCM decrypt requires the tag via
  `HUKS_TAG_AE_TAG` with the ciphertext body (tag split off) as inData.
- **presentPicker** (`model/PickerPrimitives.ets`) over
  `@ohos.file.picker.DocumentViewPicker` (user scope): dismissal resolves
  null (a value); a grant binds `user:<uuid>` to the picked URI, with the
  user-scope fs surface (fsRead/fsWrite/fsScope.persist/resolve for
  `user:`/`bkm:` handles) in the same module — the binding-mode C backend
  (`gateway_smoke.cpp`) forwards platform primitives AND non-app-scope fs ops
  to ArkTS while the C side keeps serving the app scope, so the regression
  trio is untouched. fileIo opens picker URIs read-only and cannot CREATE
  doc-provider files (that needs `picker.save`), so the user-scope proof is
  read-based — the same shape `m4.host-binding` proves on Android.
- **Scenario/manifest**: `m5.host-binding` grows to 27 one-to-one events —
  descriptor 9/0, the http legs, picker dismiss + grant with
  fsRead/persist/resolve, approval, keychain roundtrip + delete — and the
  carrier/session legs stay. Evidence in `hosts/harmony/artifacts/
  m5-primitives/` (capture files, checker verdicts 27/27 + regression trio
  green in the same launch, MANIFEST.md expected↔logged line map, receipt).

## Alternatives considered

- Settling httpFetch with the Android twin's string `bodyId:"body:<n>"`:
  rejected — quickjs' abort seam coerces the string through `ToInt32` to 0,
  so a host-side abort could never match the in-flight request; the numeric
  id keeps the shim's Map lookups working (both forms are tolerated there)
  and makes `abort()` genuinely cancel the request.
- Serving user-scope fs inside `gateway_smoke.cpp` (C) via new URI APIs:
  rejected — URI permissions live in the ArkTS capability layer; forwarding
  non-app scopes keeps path policy in the platform layer (mirroring the iOS
  embedder) and leaves the C app-scope fs byte-for-byte the regression path.
- Moving fs primitives wholesale from C to ArkTS for scope unification:
  rejected — a rewrite of the proven regression surface for no contract gain;
  the app scope stays C-served exactly as `m2.*` verified it.
- Storing keychain secrets as plaintext files or preferences: rejected — the
  twin hosts seal secrets with the platform keystore (Keystore/SecItem);
  plaintext would silently downgrade the trust level while the descriptor
  claims keychain availability.
- Seeding the picker proof from the host shell (`hdc shell` into the docs
  tree, like Android's `/sdcard` staging): impossible on this image — the
  emulator is undebuggable and the docs share is root-only, and the image
  ships no user files at all; the save-dialog bootstrap (driver-tapped,
  unique per-run name, `host.seed` bridge event) is the only honest way to
  stage a user file for the select-based grant to read.
