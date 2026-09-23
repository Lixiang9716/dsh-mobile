#!/usr/bin/env bash
# test/e2e/run-ios-upstream-suite.sh — the UPSTREAM DSH TEST SUITE on the
# iOS simulator (scenario `upstream.suite`).
#
# One transpiled upstream spec (default: core__agent-loop__tests__loop.spec,
# the spec PR #161 proved) runs inside DSHSpike through the quickjs-shaped
# vitest harness, every test streaming a structured verdict; the runner
# first executes the SAME spec under plain Node through the same harness
# (test/upstream-suite/smoke.mjs) and demands the two summaries AGREE —
# the differential discipline the parity leg uses, applied to upstream's
# own tests. The spec path rides the launch environment
# (SIMCTL_CHILD_DSH_UPSTREAM_SPEC → the launch-env snapshot).
#
# usage: run-ios-upstream-suite.sh [--udid U] [--art-dir D] [--skip-build] [--spec NAME]
#   --spec NAME   the upstream-tests/ file name (default: the loop spec)
#
# Rule 8 discipline: every wait polls a condition with a deadline. Overall
# deadline 300s — on expiry it fails loud with the last 50 log lines.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART="hosts/ios/artifacts/upstream-suite"
SKIP_BUILD=0
SPEC="core__agent-loop__tests__loop.spec.mjs"
APP_BUNDLE_ID=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --spec) SPEC="$2"; shift 2 ;;
    *) echo "usage: run-ios-upstream-suite.sh [--udid U] [--art-dir D] [--skip-build] [--spec NAME]" >&2; exit 2 ;;
  esac
done
LOG="$ART/logs.txt"
mkdir -p "$ART" "$ART/screens"

log() { echo "run-ios-upstream-suite: $*"; }
die() { echo "run-ios-upstream-suite: FAIL: $*" >&2; exit 1; }

wait_line() { # PATTERN TIMEOUT_SECONDS — poll the log for a marker
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    grep -q "$1" "$LOG" 2>/dev/null && return 0
    sleep 1   # paces the log poll; grep asserts after each wait
  done
  grep -q "$1" "$LOG" 2>/dev/null
}

fail_deadline() {
  echo "run-ios-upstream-suite: DEADLINE EXPIRED: $*" >&2
  echo "----- last 50 log lines -----" >&2
  tail -n 50 "$LOG" >&2 2>/dev/null || true
  exit 1
}

# ---- 0. the spec exists + the Node reference leg (same harness, no device) --
[ -f "runtime/spike/upstream-tests/$SPEC" ] || {
  log "transpiled spec missing — materializing (vendor + transpile)"
  sh runtime/spike/vendor/ensure-dsh-tests.sh
  (cd test/upstream-suite && npm install --no-audit --no-fund >/dev/null 2>&1 && node transpile.mjs >/dev/null)
}
[ -f "runtime/spike/upstream-tests/$SPEC" ] || die "spec not produced by the pipeline: $SPEC"

log "0/5 Node reference leg (same harness under plain Node): $SPEC"
node test/upstream-suite/smoke.mjs "$SPEC" > "$ART/reference-smoke.txt" 2>&1 \
  || die "the Node reference leg itself failed — see $ART/reference-smoke.txt"
REF_SUMMARY="$(grep -o 'harness smoke: {.*}' "$ART/reference-smoke.txt" | head -1)"
log "reference: $REF_SUMMARY"

# ---- 1-3. vendor, regen the bundle header, build, install -------------------
log "1/5 vendor + regenerate the bundle header (embeds the suite leg + harness)"
runtime/spike/vendor/ensure.sh
python3 hosts/ios/Tools/gen_bundle_header.py

if [ "$SKIP_BUILD" -eq 0 ]; then
  log "2/5 xcodebuild (simulator, udid $UDID)"
  xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath hosts/ios/DerivedData 2>&1 | tail -5
else
  log "2/5 skipped (--skip-build)"
fi
[ -d "$APP" ] || die "app bundle missing: $APP (build first or drop --skip-build)"

log "3/5 boot + install"
xcrun simctl bootstatus "$UDID" -b   # already booted is fine
xcrun simctl install "$UDID" "$APP"

# ---- 3b. stage the transpiled spec tree into the app container --------------
CONTAINER="$(xcrun simctl get_app_container "$UDID" "$APP_BUNDLE_ID" data)"
rm -rf "$CONTAINER/Documents/upstream-tests"
mkdir -p "$CONTAINER/Documents/upstream-tests"
cp "runtime/spike/upstream-tests/$SPEC" "$CONTAINER/Documents/upstream-tests/"
log "spec staged: Documents/upstream-tests/$SPEC"

# ---- 4. launch + watch the per-test verdicts --------------------------------
log "4/5 launch (-dsh-mode session -dsh-scenario upstream-suite; log capture truncated)"
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
SIMCTL_CHILD_DSH_UPSTREAM_SPEC="upstream-tests/$SPEC" \
  xcrun simctl launch --terminate-running-process \
    --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
    "$UDID" "$APP_BUNDLE_ID" -dsh-mode session -dsh-scenario upstream-suite >/dev/null

log "waiting for the suite summary (deadline 300s)"
wait_line '"event":"suite/summary"' 300 || fail_deadline "suite/summary never appeared"
sleep 1
xcrun simctl io "$UDID" screenshot "$ART/screens/01-final-state.png" >/dev/null 2>&1 || true

# ---- 5. the differential verdict ---------------------------------------------
log "5/5 summary + agreement with the Node reference"
grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true
node - "$ART" <<'SUMMARY'
const fs = require('fs');
const art = process.argv[2];
let summary = null, passes = 0, fails = 0, skips = 0;
for (const line of fs.readFileSync(`${art}/logs.txt`, 'utf8').split('\n')) {
  const at = line.indexOf('{');
  if (at < 0 || !line.includes('"scenario":"upstream.suite"')) continue;
  let record;
  try { record = JSON.parse(line.slice(at)); } catch { continue; }
  const e2e = (record.data ?? [])[0];
  if (!e2e) continue;
  if (e2e.event === 'test/pass') passes += 1;
  if (e2e.event === 'test/fail') fails += 1;
  if (e2e.event === 'test/skip') skips += 1;
  if (e2e.event === 'suite/summary') summary = e2e;
}
fs.writeFileSync(`${art}/suite-summary.json`, JSON.stringify(summary, null, 2) + '\n');
if (!summary) { console.error('no suite/summary in the capture'); process.exit(1); }
console.log(`device leg: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
if (summary.failed !== 0) {
  console.error('failing tests (first 5):');
  for (const line of fs.readFileSync(`${art}/scenario.jsonl`, 'utf8').split('\n')) {
    if (line.includes('"event":"test/fail"')) console.error('  ' + line.slice(line.indexOf('{')).slice(0, 300));
  }
  process.exit(1);
}
SUMMARY

REF_PASSED="$(grep -o '"passed":[0-9]*' "$ART/reference-smoke.txt" | head -1 | grep -o '[0-9]*')"
DEV_PASSED="$(grep -o '"passed":[0-9]*' "$ART/suite-summary.json" | head -1 | grep -o '[0-9]*')"
[ "$REF_PASSED" = "$DEV_PASSED" ] \
  || die "device leg ($DEV_PASSED passed) disagrees with the Node reference ($REF_PASSED passed) — see $ART"

# The receipt (what this run proves).
cat > "$ART/receipt.json" <<EOF
{
  "host": "ios-simulator ($(xcrun simctl list -j devices | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(x['name']+' '+x['udid'] for xs in d['devices'].values() for x in xs if x['udid']=='$UDID'))") )",
  "engine": "quickjs-ng (DSHSpike; the transpiled spec's bare imports served from the embedded vendored closure)",
  "upstream": "deepseek-harness dsh-v0.1.6-alpha.2 test suite (tag tarball, sha256-pinned; spec: $SPEC)",
  "scenario": "upstream.suite",
  "proves": [
    "the upstream DSH test suite EXECUTES on the iOS simulator: the transpiled spec runs through the quickjs-shaped vitest harness inside the app, every test a structured verdict on the log stream",
    "the device summary agrees with the plain-Node reference leg running the SAME spec through the SAME harness (test/upstream-suite/smoke.mjs)"
  ],
  "checker": "run-ios-upstream-suite.sh (summary agreement: device vs Node reference)",
  "passed": $DEV_PASSED,
  "exitCode": 0
}
EOF

log "ALL SUITE CHECKS PASS (device $DEV_PASSED == Node reference $REF_PASSED, 0 failed)"
