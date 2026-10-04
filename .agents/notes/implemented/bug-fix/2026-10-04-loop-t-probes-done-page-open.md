# loop-t: the official seat's page-open gate lost its producer

Status: implemented
Related: D9

## Problem

On a #366-fixed boot (main 86b9ce03, release flavor, fresh cold start) the
official seat's WebView never navigated: `devtools /json/list` reported a
single page target with `url:''` indefinitely, no `dsh.session` cookie ever
appeared, and the carrier 401'd every cookie-authed request — while logcat
showed the boot completing cleanly (`SessionServe: serving dsh-web-official`,
`api.claim: 67 endpoints`) and **zero FAIL lines**.

The static chain: `SessionServe.kt` sets `probesDone` from exactly one bus
line — `settings.probes.done` (SessionServe.kt:409-412) — and
`maybeOpenOrigin` (SessionServe.kt:480-488) opens the origin only when
`runtimeBootApplied && probesDone`, or on a runtime failure (fail-open). But
a3e35d72 (#340) removed `post({ type: 'settings.probes.done' })` from
`runtime/spike/scenario/composer-web-live.js` when it split the settings
probes into `scenario/manager-legs-probe.js`; a repo-wide grep at 86b9ce03
finds zero JS producers left (the split's own doc comment still claims the
function carries "the probe-done bus line"). With the probes passing since
#366, no FAIL ever fires, so the fail-open — the only page-open path left on
the old, probe-failing build (5 FAIL lines, pid 10295, 18:44) — can never
trigger either. iOS `SessionServe.swift:409` carries the same dead consumer.
An apparent counter-evidence — the round-11 battery "driving the page"
successfully on the same pid — dissolved on reading its driver path: it drove
a playwright-controlled external Chromium against the carrier (heap-scanned
token + adb forward), never the app's own WebView. Reproduced before the fix
on a fresh cold boot (pid 23899): `url:''` for 3+ minutes, 0 FAIL lines, no
new cookie row — the diagnosis holds.

Nothing in CI guarded this: the harness/debug build's default boot runs the
three regression scenarios (not the serve seat), the driven legs mount other
seats (`dsh.m4`, `dsh.next`, `dsh.web`), and the serve seat exists only on
the release flavor (`MainActivity: isRelease -> bootRelease()`).

## Decision

- `composer-web-live.js` re-posts the completion line at the end of
  `probeSettingsPlugins` — the position the split's surviving comment already
  claimed — restoring the deterministic ordering the gate was measured for
  (settings.* records before page-serve records; 2026-09-22 measurement). The
  fail arm needs no line: a probe failure rides `__dshComplete(false)` into
  the host's `onRuntimeStatus(2)` -> `fail()` -> fail-open.
- The committed android host copy is re-synced (`build/build.sh sync android`;
  byte-identical staging verified).
- A new device check, `hosts/android/ci/run-page-open.sh`, pins the behavior
  end to end: fresh boot of the default seat -> the carrier's serving line in
  logcat (port) -> the webview devtools `/json/list` page url must become
  `http://127.0.0.1:<that port>/` (with or without the `?token=` credential —
  the web client `replaceState()`s the token out of the url after reading it)
  within the deadline -> zero `FAIL`/`scenario.failed` lines from this boot's
  pid (a fail-open pass on a failing boot is a finding, not a pass). It runs
  against the signed release APK (the seat is release-flavor only) and is
  wired into `dev/android` after the phases 2-5 step, which builds and signs
  that APK with the debug keystore (the same cert the install evidence
  records). Rejection-proven: with main's (unfixed) scenario bytes pushed
  into the device bundle the check exits 1 naming the broken gate.

## Alternatives considered

- **Kotlin-side: drop `probesDone` from the gate** (open on
  `runtimeBootApplied` alone). Rejected: it deletes the ordering guarantee
  the gate exists to provide — the 2026-09-22 measurement showed the
  settings.* vs page-serve record order alternating without it — and it
  silently orphans the same gate on iOS instead of fixing the shared
  producer.
- **Kotlin-side: derive "probes done" from another existing bus signal.**
  Rejected: there is none — `web.boot` precedes the probes; the e2e `emit`
  records are log lines, not bus frames. Inventing a new signal would be the
  same contract with a new name.
- **JS-side: post the line in both the pass and the fail arm.** Rejected as
  redundant: the fail arm already reaches the host through
  `__dshComplete` -> status 2 -> `fail()` -> fail-open; a second, parallel
  open path would blur which arm opened the page.
- **External-driver checks only** (playwright against the carrier, as the
  battery rounds do). Rejected as the pin: they by construction cannot see
  the app webview's navigation state — that blind spot is exactly why the
  regression lived on main green.

## Consequences

- The page-open pin runs in `dev/android` on every android/runtime/contract
  path change; a repeat of the a3e35d72 class of edit (dropping the post)
  fails CI on the emulator leg instead of surfacing weeks later in a battery
  round.
- `install -r` with data kept does NOT refresh the on-device runtime closure:
  `syncAssetDir` stamps trees with the asset name list only, so an unchanged
  file set keeps stale bytes (recorded in `.gov/surprises.jsonl`). CI is
  unaffected (fresh AVD materializes once); on-device iteration must remove
  `files/spike` (safe — the credential and registries live under
  `profiles/default/`) after reinstallation.
