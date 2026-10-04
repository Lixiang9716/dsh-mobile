# Agent Note: the Android mux frame encoder emits the RFC6455 64-bit length form — a real journal's session/follow snapshot no longer kills the page's socket (#330)

Status: implemented
Related: D5

## Problem

On the Android release seat, any session with a real turn behind it could not
be re-opened after a page reload: the official page's chat view answered
`Failed to load history: api gateway: Remote stream WebSocket failed
(gateway/internal)` and the composer fell back to `Loading models…` (#330).
The session itself was intact server-side — the journal, the artifacts, the
turn all persisted — so in-UI review of every prior session was blocked, with
no workaround short of keeping the page open across the whole device life.

The failure is transport-level, deterministic, and size-gated. The carrier's
WebSocket text-frame encoder (`CarrierServer.frame`) wrote the RFC6455
16-bit length form for EVERY payload ≥ 126 bytes; a 16-bit length field
caps at 65535, and `(size shr 8).toByte()` keeps only that field's low byte,
so a 70,000-byte frame declares 4,464. The page's WS client (a real browser
stack) reads the declared 4,464 bytes, then parses the remaining ~65.5 KB of
payload as the NEXT frame header — a protocol violation — and fails the
socket. The mux carries every stream, so one oversized frame kills
`session/follow`, `workspace/follow`, `session/control` and the assistant
fan-out at once; the gateway client folds the dead socket into a
`gateway/internal` RemoteError, which is the exact string #330 recorded.

The size gate explains the repro shape: a `session/follow` snapshot — the
whole durable journal in one `mux.item` frame — is pushed only when a follow
OPENS. A fresh session's snapshot is tiny (first-load turns worked); after a
real turn the journal carries the prompt, every streamed chunk, and every
tool record, and the snapshot clears 64 KiB — so the break surfaced exactly
on "reload, then click the session row".

## Decision

`hosts/android/app/src/main/java/com/dshmobile/spike/CarrierServer.kt`
`frame()` now emits the RFC6455 §5.2 64-bit length form (opcode byte, then
`127`, then the length as 8 big-endian bytes) for payloads ≥ 65536; the
126/65535 band keeps the 16-bit form and sub-126 keeps the 7-bit form, so
every existing small frame is byte-identical. This is the branch the iOS
sibling (`hosts/ios/App/Source/CarrierServer.swift` `sendFrame`) and the
harmony sibling (`hosts/harmony/.../CarrierServer.ets` `wsTextFrame`) already
had — only Android lacked it.

## Alternatives considered

- Client-side retry/backoff or a non-streaming history fallback (the
  direction #330 sketched): rejected as the primary fix — the corruption is
  deterministic for any journal over 64 KiB, so a retry re-corrupts forever,
  and a fallback would paper over a wire-contract violation every future
  large frame (assistant fan-outs, big tool payloads) would hit. The
  renderer-side robustness ideas stay worth their own round (a dropped
  socket currently has no client-side recovery path), but they cannot be
  the fix for a malformed encoder.
- Chunking large `mux.item` values at the bridge so no frame ever exceeds
  64 KiB: rejected — it invents a fragmentation layer the vendored page
  half does not speak, and the transport already has a correct encoding for
  large frames; the bug was one missing branch, not a missing protocol.
- Vendor-side (upstream gateway client) hardening: rejected for this round —
  upstream packages are pinned (D6); adaptations live outboard, and the
  defect is provably in this repo's carrier, not in the pinned client.
