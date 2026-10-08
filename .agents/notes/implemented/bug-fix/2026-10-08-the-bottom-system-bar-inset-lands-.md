# Agent Note: the bottom system-bar inset lands — the sidebar's Settings gear leaves the navigation bar's touch-dead region

Status: implemented
Related: issue #415; the 2026-10-08 device-verification round (T-0172 four
proofs + T-0177); the #179 remedy this completes

## Problem

The #179 insets remedy pads `android.R.id.content` by the status-bar/cutout
TOP only. On the edge-to-edge API-35 look the page's bottom edge still
renders under the navigation bar, whose region is equally touch-dead: on a
3-button-nav emulator (`InsetsSource type=navigationBars frame=[0,2208][1080,2340]`)
the sidebar rail bottom-anchors its Settings gear at device bounds
[24,2198][126,2300] — 76% of the button inside the dead band. Instrumented
DOM listeners proved the page never sees those touches (zero events, not
even the document capture listener, for taps at y ≥ 2212) while taps at
y ≤ 2200 clicked; only the button's top sliver worked. A phone user tapping
the gear anywhere in its visual bulk got nothing — the exact class #179
fixed for the top ("touches at the dead coordinates simply never arrive"),
reborn at the bottom edge once the rail's bottom-anchored layout shipped.

## Decision

`MainActivity` applies the navigation-bar bottom inset next to the top one:
`navigationBarsInsetBottom()` reads `WindowInsets.Type.navigationBars()`
(pre-30 fallback `systemWindowInsetBottom`, mirroring the existing top
helper) and the listener pads the content's bottom with it. The page
viewport ends above the bar — the same trade the top inset made (a plain
strip below the content, the standard app look), and the vendored dist
stays byte-verbatim (D6: host-side insets are the only lever).

Verified on the release build (dsh-e2e AVD, 3-button nav): the content view
now ends exactly at the bar's top (dump: `[0,136][1080,2208]`), the gear
sits fully in app space ([24,2066][126,2168]), and a plain
`input tap` at the gear's CENTER opens the settings dialog; the 内置插件
tab then opens by touch too. The drive fleet re-ran green on the same
change (run-android-full phases 1+5: the three-scenario regression and the
UI-driven composer-live-write leg — assertions are log records, never
layout bytes, so no manifest re-freeze was needed).

## Alternatives considered

- **Pad via the WebView's own container instead of android.R.id.content**:
  rejected — the #179 fix chose the content view deliberately (single
  pre-existing dispatch point in onResume); a second padding site would
  reintroduce the two-writers problem the note recorded.
- **Let the client pad with `env(safe-area-inset-bottom)`**: rejected for
  the same D6 reason as the top — the vendored official dist is pinned
  verbatim; forking the served page is not this repo's lever.
- **Consume the insets / use fitSystemWindows**: rejected — the listener's
  return-insets contract is what the #179 fix shipped and the drives depend
  on; only the padding math changes.
