#!/usr/bin/env bash
# test/e2e/run-ios-upstream-parity.sh — the UPSTREAM PARITY differential's
# iOS-simulator port leg (scenario `upstream.parity`).
#
# The vendored upstream DSH spine runs inside DSHSpike over the same scripted
# turns the Node reference leg ran (success → todo_write tool round → closing
# success → 401), and the projected session log must match the committed
# golden record-for-record (ci/parity-compare.mjs) — the same bar the macOS
# CLI and Android emulator legs meet. The scripted wire is served by the
# node-side vendored mock server ON THE HOST: the simulator shares the host's
# loopback, so the app reaches it at 127.0.0.1 through the REAL gateway
# httpFetch primitive, and the endpoint rides the launch environment
# (SIMCTL_CHILD_DSH_MOCK_LLM_URL/KEY → the launch-env snapshot
# SpikeHostFactory declares to the spine).
#
# usage: run-ios-upstream-parity.sh [--udid U] [--art-dir D] [--skip-build]
#
# Rule 8 discipline: every wait polls a condition with a deadline. Overall
# deadline 300s — on expiry it fails loud with the last 50 log lines.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART="hosts/ios/artifacts/upstream-parity"
SKIP_BUILD=0
APP_BUNDLE_ID=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
GOLDEN="$ROOT/test/e2e/fixtures/upstream-parity-reference.jsonl"
MOCK_KEY="mock-key-0001"
MOCK_WAIT_DEADLINE_SECONDS=15
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "usage: run-ios-upstream-parity.sh [--udid U] [--art-dir D] [--skip-build]" >&2; exit 2 ;;
  esac
done
LOG="$ART/logs.txt"
mkdir -p "$ART" "$ART/screens"

log() { echo "run-ios-upstream-parity: $*"; }
die() { echo "run-ios-upstream-parity: FAIL: $*" >&2; exit 1; }

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
  echo "run-ios-upstream-parity: DEADLINE EXPIRED: $*" >&2
  echo "----- last 50 log lines -----" >&2
  tail -n 50 "$LOG" >&2 2>/dev/null || true
  exit 1
}

[ -f "$GOLDEN" ] || die "parity golden missing: $GOLDEN"

# ---- 1-3. vendor, regen the bundle header (the parity scenario embeds), build
log "1/5 vendor + regenerate the bundle header (embeds scenario/upstream-parity.js)"
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

# ---- 4. the scripted mock (host-side) + launch with the endpoint in the env
MOCK_LOG="$(mktemp /tmp/dsh-mock-parity-ios.XXXXXX)"
DSH_MOCK_SEQUENCE='success tool_call_success success auth_error' \
DSH_MOCK_TOOL_NAME='todo_write' \
DSH_MOCK_TOOL_ARGS='{"todos":[{"content":"Track the parity check","status":"in_progress"}]}' \
    node runtime/spike/ci/mock-llm-server.mjs > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() {
  kill "$MOCK_PID" 2>/dev/null || true
  wait "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

MOCK_URL=""
polled=0
until grep -s '^MOCK_BASE_URL=' "$MOCK_LOG" > /dev/null; do
  if ! kill -0 "$MOCK_PID" 2>/dev/null; then
    echo "mock llm server died before announcing its endpoint:" >&2
    cat "$MOCK_LOG" >&2
    exit 1
  fi
  polled=$((polled + 1))
  if [ "$polled" -gt $((MOCK_WAIT_DEADLINE_SECONDS * 20)) ]; then
    die "mock llm server did not announce within ${MOCK_WAIT_DEADLINE_SECONDS}s"
  fi
  sleep 0.05
done
MOCK_URL="$(sed -n 's/^MOCK_BASE_URL=//p' "$MOCK_LOG" | head -1)"
log "mock llm server: $MOCK_URL"
cp "$MOCK_LOG" "$ART/mock-server-stdout.txt"

log "4/5 launch (-dsh-mode session -dsh-scenario upstream-parity; log capture truncated)"
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
SIMCTL_CHILD_DSH_MOCK_LLM_URL="$MOCK_URL" \
SIMCTL_CHILD_DSH_MOCK_LLM_KEY="$MOCK_KEY" \
  xcrun simctl launch --terminate-running-process \
    --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
    "$UDID" "$APP_BUNDLE_ID" -dsh-mode session -dsh-scenario upstream-parity >/dev/null

log "waiting for the upstream spine to boot (deadline 300s)"
wait_line '"event":"llm/runtime"' 300 || fail_deadline "the spine never reported its runtime"
shot 01-spine-booted

log "waiting for the parity completion (terminal marker)"
wait_line '"event":"upstream/completed"' 240 || fail_deadline "upstream/completed never appeared"
sleep 1
shot 02-final-state

# ---- 5. the differential: project the port records, diff against the golden --
log "5/5 parity-compare vs the committed golden + the scenario manifest"
node - "$ART" "$LOG" <<'EXTRACT'
const fs = require('fs');
const art = process.argv[2], logPath = process.argv[3];
const out = [];
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  const at = line.indexOf('{');
  if (at < 0 || !line.includes('"scenario":"upstream.parity"')) continue;
  let record;
  try { record = JSON.parse(line.slice(at)); } catch { continue; }
  const e2e = (record.data ?? [])[0];
  if (e2e?.event === 'parity/event' && e2e.record !== undefined) out.push(e2e.record);
}
fs.writeFileSync(`${art}/port.jsonl`, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
if (out.length === 0) { console.error('port leg produced no parity/event records'); process.exit(1); }
EXTRACT

node runtime/spike/ci/parity-compare.mjs "$GOLDEN" "$ART/port.jsonl" \
  | tee "$ART/parity-verdict.txt"

node test/e2e/check.mjs \
  --manifest test/e2e/scenarios/upstream-parity-cli.json \
  --log "$LOG" \
  --out "$ART/verdict.json"

grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true

# The receipt (what this run proves).
EVENTS="$(grep -c '"scenario":"upstream.parity"' "$LOG" || true)"
REF_COUNT="$(wc -l < "$GOLDEN" | tr -d ' ')"
cat > "$ART/receipt.json" <<EOF
{
  "host": "ios-simulator ($(xcrun simctl list -j devices | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(x['name']+' '+x['udid'] for xs in d['devices'].values() for x in xs if x['udid']=='$UDID'))") )",
  "engine": "quickjs-ng (DSHSpike, gateway httpFetch → host loopback mock)",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, sha256-pinned; the SAME closure the Node reference ran)",
  "scenario": "upstream.parity",
  "proves": [
    "the vendored upstream spine produces the SAME projected session log inside the iOS simulator as under plain Node: record-for-record identity against the committed golden, the shared projector normalizing both",
    "the tool round is real: the scripted todo_write tool-call streamed through the REAL gateway httpFetch primitive to the host-side mock, the upstream ToolRuntime dispatched it, and the todos projection landed identically",
    "the 401 transport-error leg surfaces as the same upstream error-finish"
  ],
  "checker": "runtime/spike/ci/parity-compare.mjs vs test/e2e/fixtures/upstream-parity-reference.jsonl + test/e2e/scenarios/upstream-parity-cli.json",
  "events": $EVENTS,
  "referenceRecords": $REF_COUNT,
  "exitCode": 0
}
EOF

log "ALL PARITY CHECKS PASS (golden $REF_COUNT/$REF_COUNT records identical)"
