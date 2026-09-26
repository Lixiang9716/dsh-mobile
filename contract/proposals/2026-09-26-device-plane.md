# Proposal: the device plane — six primitives for the host's platform SDK surface (v1.5.0 candidate)

> **Status: DRAFT (D5 proposal — nothing frozen, nothing implemented).**
> English | [简体中文](2026-09-26-device-plane.zh.md)

## Motivation

The iOS host ships sixteen primitives that cover storage, network, secrets,
presentation, and compute — but none of the platform's own device surface.
The creation-mode clients made this concrete: the fullscreen whale viewer
wants the screen to stay awake while it is open, the agent cannot tell the
user's device facts (battery, screen, locale) when asked, cannot give
feedback (haptics), cannot hand a deliverable to another app (the share
sheet), and cannot read or write the clipboard. The owner's directive
(2026-09-26) is to bring the system SDK functions into the iOS system
plugin — this proposal is the contract-first shape of that work (D5).

The curation rule is the one the minimal-set analysis (D-tier memory) and
the contract's own §1 follow: every primitive must be (a) something an
agent genuinely needs, (b) impossible or unsafe to fake with the existing
sixteen, and (c) nameable as a capability a user could refuse. Location,
camera, microphone, sensors, contacts, and full Photos-library access all
fail (c)-as-scoped-today or demand an OS permission UI whose approval flow
deserves its own design round; they are explicitly **not** in this
proposal (see Alternatives).

## The primitives (six, one extended shape)

All follow the additive rule of v1.1.0–v1.4.0: a `gateway@1` host without
the seam keeps negotiating and answers each `unavailable`. Permission
flags follow the timer precedent: one flag per capability family, declared
in the RuntimeDescriptor's `available` list, audited on every call.

### 1. `deviceInfo` — the read-only device facts (no permission flag)

```ts
export type DeviceInfo = {
  platform: "ios" | "android" | "harmonyos" | "macos" | "linux" | "windows";
  model: string;            // host-reported marketing or hardware name
  osVersion: string;        // e.g. "26.5"
  appVersion: string;       // the host app's own version
  screen: { width: number; height: number; scale: number };
  battery?: { level: number; state: "charging" | "unplugged" | "full" | "unknown" };
  lowPowerMode?: boolean;
  locale: string;           // BCP-47
  timezone: string;         // IANA
};
export declare function deviceInfo(): Promise<DeviceInfo>;
```

No permission: these are the same facts any web page's UA string carries,
plus battery (the one field a host may omit — `battery` stays `undefined`
where the OS hides it below 20%, matching UIKit's own policy).

### 2. `haptic` — one tactile cue (permission `haptic`)

```ts
export type HapticPattern =
  | "light" | "medium" | "heavy" | "rigid" | "soft"   // UIImpactFeedbackGenerator
  | "selection"                                        // UISelectionFeedbackGenerator
  | "success" | "warning" | "error";                   // UINotificationFeedbackGenerator
export declare function haptic(pattern: HapticPattern): Promise<void>;
```

A user-facing effect, not data: one call is one cue. The Android twin maps
to `VibrationEffect`; HarmonyOS to the `@ohos.vibrator` API.

### 3. `clipboardRead` / 4. `clipboardWrite` (permission `clipboard`)

```ts
export declare function clipboardRead(): Promise<
  { kind: "text"; text: string } | null>;
export declare function clipboardWrite(text: string): Promise<void>;
```

Read is the security-sensitive direction (an agent exfiltrating a copied
password is one call away), so `clipboardRead` is additionally
**approval-gated by default**: hosts surface it through the same approval
surface as `presentApproval` unless the user has granted a standing
permission (the keychain's "secrets leave only through governed calls"
rule, applied). Both calls audit with the primitive name; the read's
audit does NOT carry the text.

### 5. `presentShare` — hand a payload to the system share sheet (permission `share`)

```ts
export type SharePayload =
  | { kind: "text"; text: string }
  | { kind: "url"; url: string }
  | { kind: "files"; paths: string[] };   // paths inside granted scopes
export declare function presentShare(payload: SharePayload): Promise<
  { shared: boolean }>;
```

The system share sheet is the OS's own trust boundary: the host hands over
the payload and learns only that the sheet completed, never the
destination. `files` paths resolve through the SAME scope discipline as
`fsRead` (outside a granted scope → `denied`).

### 6. `keepAwake` — hold the screen on (permission `screen`)

```ts
export declare function keepAwake(hold: boolean): Promise<void>;
```

A boolean latch (not a lease): the creation-mode viewers are the first
caller — the whale viewer holds the screen while open and releases on
close. Hosts that have no idle timer answer `unavailable`.

### Extended shape: `presentPicker` gains `mode: "media"`

```ts
export type PickerRequest = {
  mode: "file" | "directory" | "media"; suggestedName?: string };
```

`media` presents the platform's media picker (iOS `PHPickerViewController`,
Android `PhotoPicker`, HarmonyOS `PhotoViewPicker`) and returns a scope
handle the SAME way the file picker does — read-through-scope, no library
access. This is a field extension on an existing primitive, additive by
the same §8 rule.

## Permission and audit summary

| primitive | permission flag | approval | audit payload |
| --- | --- | --- | --- |
| `deviceInfo` | — | — | call + platform |
| `haptic` | `haptic` | — | pattern |
| `clipboardRead` | `clipboard` | default ON | call only (never the text) |
| `clipboardWrite` | `clipboard` | — | kind + length |
| `presentShare` | `share` | — per call (sheet is its own consent) | kind (+ file count) |
| `keepAwake` | `screen` | — | hold |
| `presentShare` files / picker `media` | existing fs scope rules | — | paths |

## Host availability at fold time

iOS implements all six (UIKit); Android maps all six
(`VibrationEffect`, `ClipboardManager`, `Intent.ACTION_SEND`,
`FLAG_KEEP_SCREEN_ON`, `DeviceInfo` via `Build`);
HarmonyOS maps five (vibrator, pasteboard, `startAbility`-share,
`keepScreenOn`, deviceInfo) and may defer `keepAwake`. No host is REQUIRED
to implement any of them — that is what negotiation is for.

## Alternatives considered

- **One `system.*` RPC grab-bag** (a generic `callService(name, args)`) —
  rejected: it is a second, un-governed surface (the same reasoning the
  contract used to refuse a global `setTimeout`); every capability must be
  a named, refusable, auditable primitive.
- **Location / camera / microphone / sensors now** — deferred: each
  demands an OS permission prompt whose lifecycle (granted in Settings,
  revoked mid-session) deserves its own design round, and none is
  blocking the creation-mode work this proposal serves. CoreMotion event
  streams would also need a channel shape like `timer.fire` — a good
  v1.6.0 candidate once there is a consumer.
- **Clipboard without approval on read** — rejected: the approval gate is
  the difference between "the agent can read what you copied" and "the
  agent can read what you copied, once, with your knowledge".
- **A `deviceEvents` subscription stream** (battery/screen changes) —
  deferred with sensors; `deviceInfo` is a one-shot read by design (no
  polling across module boundaries, D8).

## Evidence base

The creation-mode clients (web-client-next, web-client-whale) are on all
three hosts as of #220/#221; the whale viewer's keep-awake need and the
composer's inability to share a deliverable file are the two concrete
demands. The upstream agent's own behavior supplies the rest: it asks for
device facts it cannot obtain and offers haptic feedback it cannot give.
