# Agent Note: iOS privileged layer: real nine-primitive gateway binding

Status: implemented
Related: D5

## Problem

The M1 iOS spike shipped a fake gateway: `fsRead` returned a canned
"hello from host" payload and `keychainGet` rejected with `unavailable`,
so the iOS privileged layer (entitlements, Keychain, notification
permissions, security-scoped bookmarks) existed only as a promise in
ARCHITECTURE.md §4. The contract (contract/primitives.md v1.0.0, frozen)
requires a conforming `gateway@1` host to implement all nine primitives
for real, enforce permission flags, emit a structured audit record per
call, deliver the `app.state` / `notify.response` event channels, and
settle every completion onto the runtime queue — none of which a canned
bridge can prove. Without a real binding, no DSH plugin can treat iOS as
a negotiable platform, and the M2 E2E has nothing to drive.

## Decision

The iOS app now hosts the real capability gateway under
`hosts/ios/App/Source/Gateway/`, bound through the M2 C bridge
(`dsh_spike_set_descriptor` before eval; `dsh_spike_set_gateway_dispatch`
for on_call; `dsh_spike_gateway_settle` / `dsh_spike_gateway_event`,
runtime-thread-only). GatewayCore loads the caller's `manifest.json`
from the staged bundle, fail-loud on schema violations, checks each
primitive against the manifest's required capability strings
(`<name>` / `<name>@<major>` grammar), and emits a mandatory audit line
(`dsh.gateway.audit: ` prefix + NSLog: ts, primitive, caller, verdict,
outcome — never payload contents) on a separate stdout stream so the
canonical `dsh.spike.log: ` E2E stream stays one-to-one. The nine
primitives are real: fsRead/fsWrite over a scope registry (reserved
"app" scope = the profile container `<Documents>/profiles/default/`
per data-protocols.md §1; user scopes are `user:<uuid>` handles over
security-scoped URLs; POSIX-relative paths, escape = `invalid`,
ungranted scope = `denied`, 8 MiB read cap = `invalid`); fsScope as
security-scoped bookmarks with `bkm:` refs; httpFetch over URLSession
settling `{status, headers, bodyId}` at headers with the body streamed
as ≤16 KB `http.body` events then `http.end` (failures post-settle ride
`http.error`, abort = `cancelled`); notify via UNUserNotificationCenter
(first call requests `.alert+.sound`, id `n:<uuid>`) with the center
delegate emitting `notify.response` THEN `app.state foreground` in the
frozen order, plus lifecycle-driven `app.state` edges while the session
lives; presentApproval (UIAlertController, Approve / Decline / Approve &
Remember) and presentPicker (UIDocumentPickerViewController; file pick
grants the parent directory + lastPathComponent, directory pick grants
the directory, dismissal resolves null granting nothing); keychainGet/
keychainSet over SecItem generic-password (service = bundle id,
account = ref; unset = null; set(null) deletes). GatewaySession drives
the phase on its own RuntimeThread (extracted to
`App/Source/RuntimeThread.swift`, reused by CarrierRuntime) with a 180 s
watchdog, stages `Documents/gateway-e2e/notes.txt` as the picker target,
delivers `{"event":"host.info","port"}` after eval, and pumps after
every settle/event; AppDelegate sequences boot → carrier → gateway and
prints the final `spike: sequence boot=… carrier=… gateway=…` marker.
CarrierServer adds chunked `/gateway-e2e/bytes` (2×32 B) and
`/gateway-e2e/slow` (6×16 B, 300 ms apart) after the m1 phase completes;
m1 routes, servedList ordering, and manifests are untouched. Automatable
surfaces print `spike: ui-wait/ui-done <name>` stdout markers
(notification-permission, approval, picker, notification-banner) for the
E2E driver.

## Alternatives considered

- Keeping the canned M1 bridge and adding real primitives ad hoc:
  lost because it would branch on host capabilities (the RFC 0002
  anti-pattern) and still not satisfy conformance §7 (0 declared
  unavailable on iOS).
- Running primitive handlers on the runtime thread itself: lost because
  quickjs owns that thread's stack and any blocking call (UNUserNote/
  center authorization, UIAlertController) would stall the JS runtime —
  ARCHITECTURE.md §6 requires off-thread execution with hops back.
- One URLSession per call with `downloadTask`/`bytes(for:)`:
  `bytes(for:)` (async/await) needs a concurrency executor that does not
  exist on a plain Thread and risks priority inversions; a shared
  dataTask-based session with a delegate gives incremental chunks in the
  exact ≤16 KB event shape the frozen bridge specifies.
- Exposing FS access without scopes (raw paths): rejected outright —
  it would bypass the permission-flag model the contract freezes; scope
  handles are the only path the gateway dispatches.
- Granting picker access per-file only: lost because contract §4 maps a
  file pick to a scope the caller can use for sibling reads
  (scope = parent directory); per-file scopes would break fsScope
  persist across launches.
