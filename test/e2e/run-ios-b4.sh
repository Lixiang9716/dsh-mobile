#!/usr/bin/env bash
# test/e2e/run-ios-b4.sh — the session-write E2E driver (W-RPC leg; D9):
# the upstream spine answers the OFFICIAL app's write surface. The runtime
# composes the web-boot producer WITH the write surface (real session/create
# + prompt admission + the session/follow + workspace/follow streams), the
# probe picks the seeded workspace and TYPES INTO THE REAL COMPOSER, the
# send drives a REAL upstream agent-loop turn (scripted-llm transport), and
# the reply renders live in the official UI. Builds DSHSpike, stages the
# vendored official dist + the web-boot plugin files, launches in
# SESSION-WRITE mode (-dsh-mode session-write), and verifies the captured
# log against the one-to-one manifest b4-write-live.json. Screenshots are
# saved artifacts (screens/) — the verdict is logs only.
#
# usage: run-ios-b4.sh [--udid U] [--art-dir D] [--skip-build]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART=""
SKIP_BUILD=0
APP_BUNDLE_ID=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "usage: run-ios-b4.sh [--udid U] [--art-dir D] [--skip-build]" >&2; exit 2 ;;
  esac
done
[ -n "$ART" ] || ART="hosts/ios/artifacts/b4-write-live"

# `simctl launch --stdout/--stderr` resolves a path under /tmp INSIDE the
# simulator's own filesystem (the device's data/tmp), so an art dir there
# silently captures the log where this script cannot read it: the drive runs,
# every marker is written, and the runner waits out its 300s deadline for a
# file that will never appear on the host. Measured 2026-09-22. Refuse it at
# the argument boundary — a wrong art dir is an operator error, not a state to
# debug through (rule 5).
case "$ART" in
  /tmp/*|/private/tmp/*)
    echo "run-ios-b4: FAIL: --art-dir under /tmp writes into the SIMULATOR's" >&2
    echo "  filesystem, not the host's — use a path outside /tmp (e.g. a repo" >&2
    echo "  path or \$HOME). Got: $ART" >&2
    exit 2 ;;
esac
LOG="$ART/logs.txt"
mkdir -p "$ART" "$ART/screens"

log() { echo "run-ios-b4: $*"; }
die() { echo "run-ios-b4: FAIL: $*" >&2; exit 1; }

shot() { xcrun simctl io "$UDID" screenshot "$ART/screens/$1.png" >/dev/null 2>&1 && log "screenshot screens/$1.png" || true; }

wait_line() { # PATTERN TIMEOUT_SECONDS — poll the log for a marker
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    grep -q "$1" "$LOG" 2>/dev/null && return 0
    sleep 1   # paces the log poll; grep asserts after each wait
  done
  grep -q "$1" "$LOG" 2>/dev/null
}

fail_deadline() {
  echo "run-ios-b4: DEADLINE EXPIRED: $*" >&2
  echo "----- last 50 log lines -----" >&2
  tail -n 50 "$LOG" >&2 2>/dev/null || true
  exit 1
}

# ---- 1-4. dist, vendor, build, install, stage ---------------------------------
log "1/5 official dist present + manifest-verified"
test/e2e/ensure-official-dist.sh

log "2/5 vendor quickjs-ng sources"
runtime/spike/vendor/ensure.sh

if [ "$SKIP_BUILD" -eq 0 ]; then
  log "3/5 xcodebuild (simulator, udid $UDID)"
  xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath hosts/ios/DerivedData 2>&1 | tail -5
else
  log "3/5 skipped (--skip-build)"
fi
[ -d "$APP" ] || die "app bundle missing: $APP (build first or drop --skip-build)"

log "4/5 boot + install + stage dist into the app container"
xcrun simctl bootstatus "$UDID" -b   # already booted is fine
xcrun simctl install "$UDID" "$APP"
APP_DATA="$(xcrun simctl get_app_container "$UDID" "$APP_BUNDLE_ID" data)"
rm -rf "$APP_DATA/Documents/official-web"
mkdir -p "$APP_DATA/Documents/official-web"
cp -R presentation/official-web/dist "$APP_DATA/Documents/official-web/dist"

log "4b/5 stage the web-plugins tree (W-SHELL application tier + vendored bootstrap; fixed stamp)"
runtime/spike/vendor/ensure-dsh.sh > /dev/null
test/e2e/ensure-client-bundles.sh
PKG_SRC="runtime/spike/vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2"
[ -f "$PKG_SRC/lib/client.js" ] || die "vendored bootstrap package missing (ensure-dsh.sh)"
rm -rf "$APP_DATA/Documents/web-plugins"
mkdir -p "$APP_DATA/Documents/web-plugins/npm/@deepseek-ai"
cp -R presentation/official-web/client-bundles/npm/@deepseek-ai/. \
    "$APP_DATA/Documents/web-plugins/npm/@deepseek-ai/"
# The pinned vendored tarball wins for the bootstrap package (D6 pin record;
# its lib/client.js is byte-identical to the workspace build — PROVENANCE).
rm -rf "$APP_DATA/Documents/web-plugins/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2"
cp -R "$PKG_SRC" "$APP_DATA/Documents/web-plugins/npm/@deepseek-ai/"

# ---- launch + watch the log markers --------------------------------------------
log "5/5 launch (session-write mode; log capture truncated — checker sees only this run)"
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
xcrun simctl launch --terminate-running-process \
  --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
  "$UDID" "$APP_BUNDLE_ID" -dsh-mode session-write >/dev/null

# Markers: index.served → boot-screen shot; composer.typed → typed-composer
# shot; terminal sequence marker → final shot, then the checker.
log "waiting for the official page mount (index.served, deadline 300s)"
wait_line "index.served" 300 || fail_deadline "index.served never appeared"
sleep 2   # let the boot screen settle before the shot
shot 01-write-boot-screen

log "waiting for the typed composer (composer.typed marker)"
wait_line "composer.typed" 180 || fail_deadline "composer.typed never appeared"
shot 02-composer-typed

log "waiting for the session-write drive to complete (terminal marker)"
wait_line "spike: sequence session-write=" 240 || fail_deadline "terminal marker never appeared"
sleep 1
shot 03-reply-rendered

# ---- checkers -------------------------------------------------------------------
log "6/6 running checkers"
grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true
if node test/e2e/check.mjs --manifest test/e2e/scenarios/b4-write-live.json \
    --log "$LOG" --out "$ART/verdict-b4-write-live.json"; then
  echo "==================== E2E summary ($ART) ===================="
  echo "  b4-write-live             PASS"
  echo "  logs: $LOG  screens: $ART/screens/"
else
  echo "==================== E2E summary ($ART) ====================" >&2
  echo "  b4-write-live             FAIL" >&2
  echo "  logs: $LOG  screens: $ART/screens/" >&2
  die "b4-write-live checker failed — see $ART/verdict-b4-write-live.json"
fi
