# Agent Note: the layout-truth probe: native occlusion of the web surface becomes a log-asserted scenario event

Status: implemented
Related: D3

## Problem

The log-based E2E contract has one blind spot, and the tree hit it for
real: on 2026-09-24 the unthemed launch activity painted its action bar
OVER the WebView's top ~228px (issue #179), leaving the settings tab
strip, the dialog Close, and the sidebar controls touch-dead — while
every scenario manifest stayed green. The event stream cannot see this
class: a native surface drawn over the page logs nothing, and the page's
own drive probes only prove what the page CAN reach — touches at the
occluded coordinates simply never arrive (the #179 fix note records the
same verdict: "element-driven E2E cannot catch this class"). What was
missing is a geometry assertion surface that speaks the same currency as
everything else CI judges: one structured record, one-to-one checked.

## Decision

`test/e2e/ui-probe.mjs` — the layout-truth probe — reads a UI tree dump
(Android `uiautomator dump` XML, or the WebDriverAgent source JSON via
the new `ios-ui.py tree <path>`) and emits ONE canonical record onto its
own `dsh.ui.probe:` stream naming every violation of the invariant "the
web surface owns its rectangle":

- `occluder`: a node outside the web host's subtree that paints content
  (own or descendant text / interactive) and intersects the WebView's
  rectangle — the #179 detector, needing only the native nodes;
- `outside`: an interactive web-host descendant whose center falls
  outside the host rectangle (clipped / scrolled out);
- `untappable`: an interactive node with a zero-area rectangle.

The record is judged by the ordinary `check.mjs` against the new
`scenarios/ui-occlusion.json` (`violations: []` is the pass match; the
mismatch report carries the named list, which is the diagnosis). The
probe fails loud (exit 2) on an unparsable dump, unparsable geometry, or
a dump with no WebView — a probe that silently scanned nothing is a
vacuous pass (rule 5). `selftest.sh` proves the pass/fail/loud paths
through the checker against synthetic #179-class fixtures (rule 6).
Wired into `run-android-full.sh` phase 3: after the scenario verdict,
the still-mounted shell's tree is dumped (bounded retry, rule 8), probed,
and the probe record + verdict land beside the other evidence.

The probe stream is deliberately SEPARATE from the existing scenario
manifests: committed evidence is frozen and `matrix.mjs` drift-checks
each verdict's expect count against its manifest, so wiring the probe as
a new row in `android-officialweb-mount.json` would retro-count events
the frozen captures cannot contain and re-open frozen evidence. A leg
adopts the probe by adding one dump + one probe call + one extra verdict,
touching nothing already committed.

## Alternatives considered

- **A `ui.probe` row in the existing scenario manifests** — the one-to-one
  contract stays whole per scenario, but every committed capture for that
  scenario predates the probe and frozen evidence is never edited; the
  matrix gate's drift check (expect count vs verdict) would go red and
  the "fix" would be regenerating evidence whose provenance is an older
  commit. Rejected; the separate stream keeps adoption additive.
- **Visual/screenshot assertions on CI** — rejected long ago (the
  "E2E by logs" contract; non-deterministic across runner images) and
  still rejected: geometry over the a11y/View tree is deterministic and
  needs no pixel pipeline. The probe is the deterministic subset of what
  screenshot diffing would buy.
- **A Python probe inside `ios-ui.py`** — one violation engine per format
  instead of one for both; the WDA face would drift from the uiautomator
  face. Rejected; `ios-ui.py` grows only the `tree` saver (6 lines) and
  the Node tool consumes both dump shapes.
- **Host-side instrumentation (an in-app overlay listener logging
  occlusion)** — would put the assertion inside the app under test and
  per-platform code in every host; the tree dump is the same evidence the
  drives already use, so the probe stays test-side with zero app surface.

## Consequences

The #179 class is now a red scenario instead of a screenshot find:
`android-officialweb-mount` legs fail loud when a native surface covers
the page. Coverage is honest per platform — the occluder tier works on
any dump (native nodes only), while `outside` needs web content nodes in
the tree (always present via WDA on iOS; on Android only when Chromium's
accessibility is exposed to uiautomator — the record's `scanned.web`
count says which face ran). Known-benign overlaps are excluded by name
via `--allow` and the exclusion rides the record (`allowed`/`dropped`).
iOS live wiring is the `tree` command + fixtures; the first on-simulator
probe run rides the existing WDA loop and is CI's to prove (this box has
no iOS toolchain).
