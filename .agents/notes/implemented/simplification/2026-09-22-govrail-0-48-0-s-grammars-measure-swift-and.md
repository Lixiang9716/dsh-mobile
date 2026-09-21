# Agent Note: govrail 0.48.0's grammars measure Swift and Kotlin precisely, and four functions were over the line

Status: implemented

## Problem

Upgrading the plane to govrail 0.48.0 — which ships Swift and Kotlin grammars in
the parse layer (#361) — turns the `code-size` gate **red on the existing tree**,
in four distinct places (reported as six violations, one function twice):

```
hosts/android/app/build.gradle.kts:87:  FUNC 75 lines > 50     (the android {} block)
hosts/android/…/OfficialWebProbe.kt:32: FUNC 54 lines > 50     (probeScript's JS payload)
hosts/ios/App/Source/AppDelegate.swift:31: FUNC 78 lines > 50  (application(_:didFinishLaunchingWithOptions:))
hosts/ios/App/Source/WebBootRuntimeDriver.swift:39/47: 69/60   (WebBootRuntimeDrive.start, twice)
```

Hand-measured by brace matching, the sizes are real: 75 (Gradle block, 87–161),
54 (`probeScript`, 32–85), 78 (`application`, 31–108), 70 (`start`, 38–107). The
ruler is imprecise around the edges — it reported 53 functions in a 243-line
Swift file with empty name columns, and double-reported one span — but the
substance is not an artifact, so the response is to fix the code rather than the
ruler. (The imprecision is reported upstream as field feedback, not silently
worked around: the gate stayed enabled and blocking.)

## Decision

**All four are refactored into units under 50 lines, with behaviour unchanged —
including the bytes of the one payload that reaches a device.**

- **`build.gradle.kts`**: the `android {}` block becomes a ~20-line composition
  of four extension functions on `ApplicationExtension` (`dshBuildTypes`,
  `dshSourceSets`, `dshDefaultConfig`, `dshNativeBuild`), called in the DSL's
  original order. The declarations sit below the block, each carrying its own
  comments verbatim — the configuration is the same configuration, in four
  readable units instead of one 75-line block.
- **`OfficialWebProbe.kt`**: the probe's JavaScript is DATA, so it becomes
  `private val PROBE_TEMPLATE` with the object's own wait bounds interpolated
  once, and `probeScript(comboURL)` is a one-line builder replacing
  `__COMBO_URL__`. **Proven byte-identical**: the emitted JS is 2539 bytes both
  ways (HEAD's payload with the same substitutions, `trimIndent` applied) — so
  the b1 leg's on-device evidence is unaffected by the move.
- **`AppDelegate.swift`**: the delegate builds the console and web view through
  `makeConsole`/`makeWebView`, then `startLaunchedMode()` switches on
  `-dsh-mode`. The stdout lines the E2E asserts on are spelled out per case
  rather than assembled (only `session` carries the surface, via a
  `sessionSurface` computed property), so the log stream is exactly what it was.
- **`WebBootRuntimeDrive.swift`**: `start()` becomes the thread hop plus five
  named steps — `bootHost`, `wireGateway`, `wireSinks`, `evalScenario`,
  `deliverStaging` — each returning a Bool so the guards keep their original
  order and the failure messages stay identical.

Verified: `code-size` reports **0 violations** over 230 files under govrail
0.48.0, `hosts/android` builds (`gradlew assembleDebug`, APK produced), and
`hosts/ios` builds (`xcodebuild build -destination 'generic/platform=iOS
Simulator'`, BUILD SUCCEEDED). The card is T-0034.

## Alternatives considered

**Add a size exemption marker and leave the four functions alone.** Rejected:
each is genuinely over the line, and an exemption would have been invented in
the same change that needed it — the shape the rules call a visible declaration
only when the declaration is honest. Three of the four also read better split;
the fourth (the Gradle block) is neutral on readability and the rule is the
rule.

**Treat the gate as unreliable and pin the plane to 0.47.1.** Rejected: the
upgrade is the point, the findings are real, and disabling or pinning a gate to
keep a red out of sight is the move the plane exists to prevent.

**Move the probe's JS payload to an Android asset file instead.** Rejected for
now: it changes the delivery path (a Context, an asset read that can fail, a
runtime failure mode) to solve a size-classification problem. The data-vs-code
split fixes the classification with no new failure mode and a provable
byte-identity.

**Compress the Swift fixes by shortening the signatures instead of extracting
steps.** Rejected: the 78-line delegate is a sequence of distinct phases, and
naming them is what makes the launch path readable; wrapping the signature would
have moved lines without creating a unit.
