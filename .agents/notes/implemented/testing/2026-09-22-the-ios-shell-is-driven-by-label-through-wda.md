# Agent Note: the iOS shell is driven by label through WDA, and every control gets a verdict

Status: implemented
Related: none

## Problem

"Test every button and screen of the DSH app" needs an auditable result, and
the tools available on this machine made that expensive and unreliable:

- `idb ui describe-all` returns ONLY the app root for a WKWebView — the page's
  elements are not in the tree — and `idb ui describe <marker>` searches
  labels but sees the same nothing. The only way to inventory the page with
  idb is to sample points: ~20s per screen, and the answer is stale the moment
  the page re-lays-out (a growing transcript moves the composer; the top
  safe-area inset moved the whole page 62pt).
- idb's coordinate space is not `screenshot_pixels / 3` (the device's AX space
  is 402x874 against 1179x2556 pixels), so a coordinate read off a screenshot
  lands on the element ABOVE the target. Two separate sweeps reported
  nine-of-eleven and then all-no-op false negatives from exactly this.
- `idb ui text` types character by character (~1s each) and blocks the input
  path. A 100-character prompt occupies it for minutes, and a human typing in
  the Simulator queues behind it — which presents as "the app hangs when the
  cursor is in the input" and is not an app defect at all.
- The simulator's display can stop updating after repeated install/launch
  cycles: two screenshots across a real change come back byte-identical while
  the app is demonstrably alive and responsive.

## Decision

`tools/e2e/ios-ui.py` drives the app by LABEL through the **WebDriverAgent this
repository already bootstraps** (`tools/e2e/run-ios.sh` `wda_bootstrap`;
appium/WebDriverAgent on `localhost:8100`). WDA publishes the complete
accessibility tree of the WebView in one call (~1s), with frames in the same
coordinate space idb taps use.

Four rules, each one measured rather than assumed:

1. **Never cache a coordinate.** Every action re-reads the tree; the sweep
   re-reads it per control (with WDA that costs ~1s, against a `no-op` verdict
   that costs the whole checklist).
2. **Press coordinates, do not click elements.** WDA's
   `/element/:id/click` returns success but does not dispatch into a WKWebView
   (measured: the onboarding modal stayed up); `wda/dragfromtoforduration` at
   the frame centre does.
3. **Type through the element value endpoint**, which is O(1), never through
   per-character injection.
4. **Record what cannot be reached.** A control whose frame is off-screen is
   recorded as `skipped: off-screen (needs scrolling)` — a press there lands on
   whatever sits at that edge, so a verdict would be a lie.

`ios-ui.py sweep <dir>` writes `checklist.json` (label, role, centre, changed,
the two screenshot filenames) plus the before/after PNGs. `changed` is a
byte-difference between the two captures: it says the tap had a VISIBLE effect,
which is what a button test is about.

## Evidence

- `hosts/ios/artifacts/ui-sweep/` — the home screen and everything reachable
  from it: 60 control activations, 48 with a visible effect, across the rail,
  the workspace chip, the composer row, the session sidebar, session search,
  the plugins panel and the plugin detail (Agent loop).
- `hosts/ios/artifacts/ui-sweep-conversation/` — the conversation view and its
  trajectory tab: 60 activations across the transcript, the tool-call section,
  the message actions, 对话/轨迹 and the trajectory toolbar (使用实际时长,
  收起/展开所有轮次, 收起/展开所有调用, 搜索轨迹).

Two defects came out of the sweeps, both with screenshots in the directories
above, and both in the **vendored official client** (`presentation/official-web`,
a pinned upstream build — D6 forbids editing it, so both are upstream reports
rather than local fixes):

1. The plugins panel renders `暂时无法读取插件。` with a `重试` button: the page
   asks the spine for the plugin inventory and the spine does not answer that
   endpoint (the carrier claims the session/write surface only).
2. With the session sidebar open, the plugins panel collapses to roughly one
   character wide and its text wraps vertically. The layout does not adapt two
   panes to a 402pt-wide phone screen; the same panel renders correctly with
   the sidebar closed.

## Consequences

- A control sweep of any screen is one command, and its result is a checklist a
  human can audit without opening a single image.
- The driver is the foundation for the remaining UI work (a file-tool card, the
  settings surface, the tool inventory) — none of it needs coordinate
  archaeology again.
- `idb` stays in use for what it is good at here (simulator power control, the
  HOME button, screenshots), and `ios-ui.py recover` reboots a device whose
  display has frozen.

## Alternatives considered

- **Keep driving through idb and fix the coordinate maths.** The screenshots
  are 1179x2556 pixels and the device's AX space is 402x874, so one can
  compute the scale once — but that only fixes the FIRST tap: the page
  re-lays-out on every navigation (measured: the composer moved from y=478 to
  y=731 inside one conversation), and idb has no tree to re-derive from. The
  coordinate problem is not a constant error to correct; it is a stale value
  to avoid.
- **Screen-scrape with `simctl io screenshot` plus OCR.** Heavier than the
  accessibility tree, loses the frames, and would need a font-perfect match to
  place a tap.
- **Install a second automation stack (Appium server, XCUITest harness).**
  WebDriverAgent IS that stack's core, already cloned and built here by
  `run-ios.sh`, and already used by this repository for system-UI legs. Adding
  a wrapper on top would add a dependency without adding reach.
- **Click elements instead of pressing coordinates.** Measured to fail: WDA's
  `/element/:id/click` returns success and does not dispatch into the
  WKWebView, so the onboarding modal stayed up through repeated clicks while a
  coordinate press at the same element's centre dismissed it in one.
- **Screenshot every step and read them all.** What the acceptance asked for
  is a result a human can audit; 120 images is not that. The checklist carries
  the verdict and the images are its receipts.
