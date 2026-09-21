#!/usr/bin/env bash
# run.sh — the iOS half of the release-logging evidence: prove the ABSENCE of
# test machinery in the user-facing build, and the PRESENCE of it in the
# harness.
#
# Release (dsh-ios): a plain launch — NO launch arguments, NOTHING staged into
# the app container — must reach the official DSH Web UI (the embedded dist +
# client bundles), emit ZERO `dsh.spike.log:` records, ZERO verdict text, and
# ZERO `"level":"debug"`/`"level":"info"` records.
# Debug (dsh-ios-harness): the same plain launch must still produce the full
# structured E2E stream — the harness evidence cannot regress.
#
# usage: hosts/ios/artifacts/release-logging/run.sh [--skip-build]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
# Absolute: simctl refuses to launch when --stdout/--stderr carry a
# relative path (it resolves them outside this shell's cwd, fails to
# create the file, and SpringBoard denies the launch).
ART="$ROOT/hosts/ios/artifacts/release-logging"
UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"
APP_BUNDLE_ID=org.dsh.DSHSpike
DD="${DSH_IOS_DD:-/tmp/dsh-release-logging-dd}"
REL_APP="$DD/Build/Products/Release-iphonesimulator/DSHSpike.app"
DBG_APP="$DD/Build/Products/Debug-iphonesimulator/DSHSpike.app"
SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

mkdir -p "$ART"
log() { echo "release-logging(ios): $*"; }
die() { echo "release-logging(ios): FAIL: $*" >&2; exit 1; }

if [ "$SKIP_BUILD" -eq 0 ]; then
  log "vendoring + the official web trees the Release build embeds"
  sh runtime/spike/vendor/ensure.sh
  sh runtime/spike/vendor/ensure-dsh.sh >/dev/null
  tools/e2e/ensure-official-dist.sh
  tools/e2e/ensure-client-bundles.sh
  for cfg in Release Debug; do
    log "xcodebuild ($cfg)"
    xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
      -configuration "$cfg" -destination "platform=iOS Simulator,id=$UDID" \
      -derivedDataPath "$DD" 2>&1 | tail -3
  done
fi
[ -d "$REL_APP" ] || die "release app bundle missing: $REL_APP"
[ -d "$DBG_APP" ] || die "debug app bundle missing: $DBG_APP"
xcrun simctl bootstatus "$UDID" -b >/dev/null

# The embedded tree is part of the artifact: record what shipped.
log "embedded resources: dist=$(find "$REL_APP/official-web/dist" -type f 2>/dev/null | wc -l | tr -d ' ') \
plugins=$(find "$REL_APP/official-web/plugins" -type f 2>/dev/null | wc -l | tr -d ' ')"
[ -f "$REL_APP/official-web/dist/index.html" ] || die "release app embeds no official dist"
[ -d "$DBG_APP/official-web" ] && die "debug app embeds official-web — the harness must stage Documents"

# One plain launch: fresh install, empty container, NO launch arguments.
launch() { # $1 = app, $2 = tag
  local app="$1" tag="$2"
  xcrun simctl terminate "$UDID" "$APP_BUNDLE_ID" 2>/dev/null || true
  xcrun simctl uninstall "$UDID" "$APP_BUNDLE_ID" 2>/dev/null || true
  xcrun simctl install "$UDID" "$app"
  local data
  data="$(xcrun simctl get_app_container "$UDID" "$APP_BUNDLE_ID" data)"
  [ -z "$(ls -A "$data/Documents" 2>/dev/null)" ] ||
    die "container Documents is not empty before the $tag launch"
  sleep 3   # paces SpringBoard's install bookkeeping (the launch is asserted below)
  # Window the unified log to THIS run only: a bare `--last 2m` would pull in
  # the previous launch's records and make the absence assertion lie.
  local since
  since="$(date '+%Y-%m-%d %H:%M:%S')"   # log show reads LOCAL time"
  sleep 1
  # SpringBoard refuses a launch that races its own install/uninstall
  # bookkeeping; retry with a deadline rather than a blind pause (rule 8).
  local deadline=$((SECONDS + 60)) ok=1
  while [ "$SECONDS" -lt "$deadline" ]; do
    if xcrun simctl launch --terminate-running-process \
      --stdout="$ART/$tag.stdout.txt" --stderr="$ART/$tag.stderr.txt" \
      "$UDID" "$APP_BUNDLE_ID" > "$ART/$tag.launch.txt" 2>&1; then
      ok=0
      break
    fi
    sleep 3
  done
  [ "$ok" -eq 0 ] || {
    cat "$ART/$tag.launch.txt" >&2
    die "the $tag launch never took (SpringBoard refused for 60s)"
  }
  sleep 25
  xcrun simctl io "$UDID" screenshot "$ART/$tag.png" >/dev/null 2>&1
  # Read the unified log AFTER the fact rather than tailing a live stream:
  # a background `log stream` holds the device busy and makes SpringBoard
  # refuse the launch (observed here, 60s of refusals).
  xcrun simctl spawn "$UDID" log show --start "$since" \
    --predicate 'process == "DSHSpike"' --style compact \
    > "$ART/$tag.oslog.txt" 2>&1 || true
}

count() { # $1 = file, $2 = fixed string
  grep -c -F "$2" "$1" 2>/dev/null || true
}

log "launch 1/2 — dsh-ios (release), plain launch, nothing staged"
launch "$REL_APP" plain-launch-release
for f in "$ART/plain-launch-release.stdout.txt" "$ART/plain-launch-release.stderr.txt" \
         "$ART/plain-launch-release.oslog.txt"; do
  [ "$(count "$f" 'dsh.spike.log:')" -eq 0 ] ||
    die "release emitted an E2E record ($f)"
  [ "$(count "$f" 'dsh.spike.verdict')" -eq 0 ] ||
    die "release emitted verdict text ($f)"
  [ "$(count "$f" '"level":"debug"')" -eq 0 ] ||
    die "release emitted a debug record ($f)"
  [ "$(count "$f" '"level":"info"')" -eq 0 ] ||
    die "release emitted an info record ($f)"
done
[ "$(count "$ART/plain-launch-release.stdout.txt" 'dsh.gateway.audit:')" -eq 0 ] ||
  die "release emitted a gateway audit line"

log "launch 2/2 — dsh-ios-harness (debug), same plain launch"
launch "$DBG_APP" plain-launch-harness
HARNESS_RECORDS="$(count "$ART/plain-launch-harness.oslog.txt" 'dsh.spike.log:')"
[ "$HARNESS_RECORDS" -gt 0 ] ||
  die "the harness emitted no E2E records — its evidence regressed"

# The refusal (rules.md rule 5): a release binary asked for a drive says so.
# Reinstall the RELEASE build — the harness launch above left the debug app.
xcrun simctl terminate "$UDID" "$APP_BUNDLE_ID" 2>/dev/null || true
xcrun simctl uninstall "$UDID" "$APP_BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$REL_APP"
sleep 3   # paces SpringBoard's install bookkeeping
REFUSAL_SINCE="$(date '+%Y-%m-%d %H:%M:%S')"
xcrun simctl launch --terminate-running-process "$UDID" "$APP_BUNDLE_ID" \
  -dsh-mode session >/dev/null 2>&1 || true
sleep 8
xcrun simctl spawn "$UDID" log show --start "$REFUSAL_SINCE" \
  --predicate 'process == "DSHSpike"' --style compact \
  > "$ART/refusal.oslog.txt" 2>&1 || true
[ "$(count "$ART/refusal.oslog.txt" 'dsh.spike.log:')" -eq 0 ] ||
  die "the refusal capture carries E2E records — the window leaked" 
grep -q "release build: refusing '-dsh-mode session'" "$ART/refusal.oslog.txt" ||
  die "the release build did not refuse an E2E drive"

log "release: 0 E2E records / 0 verdict / 0 debug+info; harness: $HARNESS_RECORDS E2E records"
log "artifacts in $ART"
