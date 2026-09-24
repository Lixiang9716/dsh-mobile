# Agent Note: the WebView owns the window — the title-bar occlusion ends

Status: implemented

## Problem

The launch Activity was unthemed (`android.app.Activity` under the default
Material look), which draws the label action bar OVER the fullscreen
WebView on the targetSdk-35 edge-to-edge look: the page laid out from
y=0 behind an opaque ~228px black "DSH Spike Host" bar. Everything the
official client renders in that top strip was invisible AND touch-dead on
the phone — the settings dialog's entire tab strip (General / Models /
Built-in plugins / Agent presets, y≈23-123), its Close button, and the
sidebar's Open-sidebar / New-session icons. A phone user could not reach
Models settings at all (found in the 2026-09-24 overnight release
walkthrough, issue #179; screenshots in the issue). The log-verified
drives cannot catch this class: they drive by DOM elements, and touches
at the dead coordinates simply never reach the page.

## Decision

Two pieces, both in the platform host:

1. A real launch theme (`res/values/themes.xml`):
   `Theme.Material.Light.NoActionBar` + `windowLightStatusBar=true` +
   white `windowBackground` — the page's own header renders, and the
   light status-bar icons match the client's light surface.
2. Status-bar/cutout inset applied to `android.R.id.content` in
   `MainActivity.onResume`, with `requestApplyInsets()`. With the action
   bar gone the page still starts at y=0, and the system status-bar /
   display-cutout region still swallowed touches up to ~128px on the
   emulator (proven: taps at the tab strip's exact bounds stayed dead
   while the same button responded to keyboard Enter). Padding the
   content shifts the whole page viewport below the bars, so every
   element lands at a touchable coordinate. Two constraints shaped the
   code: the listener is registered in onResume (a listener attached
   before `setContentView()` never sees the first insets dispatch), and
   it lives in the single pre-existing `onResume` (the dispatchResume
   hop) rather than a conflicting second override.

## Alternatives considered

- Only the theme change, no insets — verified insufficient on-device:
  the tab strip moved into the status-bar/cutout touch-dead region
  (y≈23-123) and taps still did nothing.
- Shipping the page edge-to-edge and letting the client pad via
  `env(safe-area-inset-top)` — the vendored official dist is pinned
  verbatim (D6); host-side insets are the only lever this repo owns.
- A WebView stylesheet/JS injection to pad the page — same D6 objection,
  plus it forks the served page from the pinned bytes.

## Consequences

The full touch path works on-device: gear → dialog opens with the tab
strip visible → Models taps through and switches (verified with the
release APK, screenshots in issue #179). The page no longer draws under
the status bar (a plain white strip above the content) — the standard
app look, and the honest trade for a reachable UI. The drive modes share
the inset (their verdict TextView starts below the bars; every
manifest-matched log line is unaffected — assertion streams never touch
layout).
