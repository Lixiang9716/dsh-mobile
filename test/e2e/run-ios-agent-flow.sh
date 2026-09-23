#!/usr/bin/env bash
# test/e2e/run-ios-agent-flow.sh — the AGENT-FLOW leg on the iOS simulator
# (scenario `agent.flow`): prompt 修改 + skills 载入 over the vendored
# upstream skill family, in one on-device session.
#
# The drive boots the mobile profile spine WITH the skill family mounted
# (dsh-skill registry, dsh-skill-filesystem discovery with watch:false,
# dsh-tool-skill tool + catalog) and the SystemPrompt personaPrefix override,
# then proves, in order: fixture staging → discovery into ctx.skills → the
# `skill` tool returning the fixture instructions → a mock-LLM turn whose
# CAPTURED wire request carries the override in its system message and the
# skill tool in its tools array → the session catalog message → a scripted
# `skill` TOOL-CALL round through the real agent loop, whose tool result feeds
# the closing request. The verdict is LOG-ONLY against
# test/e2e/scenarios/agent-flow.json (17 expected events, one-to-one, in
# order); screenshots are artifacts, never assertions.
#
# The scripted wire is the node-side vendored mock server ON THE HOST (the
# simulator shares the host's loopback; the endpoint rides the launch
# environment SIMCTL_CHILD_DSH_MOCK_LLM_URL/KEY exactly like the parity
# drive): success → `skill` tool_call_success → closing success.
#
# usage: run-ios-agent-flow.sh [--udid U] [--art-dir D] [--skip-build]
#
# Rule 8 discipline: every wait polls a condition with a deadline (log
# markers); sleeps only pace the polls. Overall deadline 300s — on expiry
# it fails loud with the last 50 log lines.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART="hosts/ios/artifacts/agent-flow"
SKIP_BUILD=0
APP_BUNDLE_ID=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
MANIFEST=test/e2e/scenarios/agent-flow.json
MOCK_KEY="mock-key-0001"
MOCK_WAIT_DEADLINE_SECONDS=15
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "usage: run-ios-agent-flow.sh [--udid U] [--art-dir D] [--skip-build]" >&2; exit 2 ;;
  esac
done
LOG="$ART/logs.txt"   # derived AFTER arg parsing — --art-dir must apply
mkdir -p "$ART" "$ART/screens"

log() { echo "run-ios-agent-flow: $*"; }
die() { echo "run-ios-agent-flow: FAIL: $*" >&2; exit 1; }

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
  echo "run-ios-agent-flow: DEADLINE EXPIRED: $*" >&2
  echo "----- last 50 log lines -----" >&2
  tail -n 50 "$LOG" >&2 2>/dev/null || true
  exit 1
}

# ---- 1-3. vendor, regen the bundle header (the agent-flow scenario and the
# skill closure embed), build, install
log "1/5 vendor + regenerate the bundle header (embeds scenario/agent-flow.js + the skill closure)"
runtime/spike/vendor/ensure.sh
runtime/spike/vendor/ensure-dsh.sh
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
MOCK_LOG="$(mktemp /tmp/dsh-mock-agent-flow.XXXXXX)"
DSH_MOCK_SEQUENCE='success tool_call_success success' \
DSH_MOCK_TOOL_NAME='skill' \
DSH_MOCK_TOOL_ARGS='{"name":"greeter"}' \
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

log "4/5 launch (-dsh-mode session -dsh-scenario agent-flow; log capture truncated)"
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
SIMCTL_CHILD_DSH_MOCK_LLM_URL="$MOCK_URL" \
SIMCTL_CHILD_DSH_MOCK_LLM_KEY="$MOCK_KEY" \
  xcrun simctl launch --terminate-running-process \
    --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
    "$UDID" "$APP_BUNDLE_ID" -dsh-mode session -dsh-scenario agent-flow >/dev/null

log "waiting for the spine + skill plane to boot (deadline 300s)"
wait_line '"event":"skill/plane/mounted"' 300 || fail_deadline "skill/plane/mounted never appeared"
shot 01-spine-booted

log "waiting for the prompt-override turn (first captured request asserted)"
wait_line '"event":"prompt/override/asserted"' 120 \
  || fail_deadline "the prompt override never reached the captured LLM request"
shot 02-override-asserted

log "waiting for the tool round (the skill tool-call through the real loop)"
wait_line '"event":"tool/result/fed/request"' 120 \
  || fail_deadline "the skill tool result never fed the closing request"
shot 03-tool-round

log "waiting for completion (terminal marker)"
wait_line '"event":"upstream/completed"' 120 || fail_deadline "upstream/completed never appeared"
sleep 1
shot 04-final-state

# ---- 5. the log-only verdict ------------------------------------------------
log "5/5 checking the scenario manifest (one-to-one, in order)"
node test/e2e/check.mjs \
  --manifest "$MANIFEST" \
  --log "$LOG" \
  --out "$ART/verdict.json"

grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true

EVENTS="$(grep -c '"scenario":"agent.flow"' "$LOG" || true)"
cat > "$ART/receipt.json" <<EOF
{
  "host": "ios-simulator",
  "engine": "quickjs-ng (DSHSpike, gateway httpFetch → host loopback mock)",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, sha256-pinned)",
  "scenario": "agent.flow",
  "proves": [
    "prompt 修改: the vendored SystemPrompt personaPrefix override reaches the captured wire request's system message",
    "skills 载入: the fixture skill is discovered from the staged dir into ctx.skills, published in the durable session catalog, and returned by the skill tool",
    "the full mock-LLM turn flow: a scripted skill tool-call dispatched through the REAL agent loop, its result feeding the closing request"
  ],
  "checker": "test/e2e/check.mjs vs test/e2e/scenarios/agent-flow.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

log "ALL AGENT-FLOW CHECKS PASS (manifest $MANIFEST, events $EVENTS)"

# ---- receipt (reachable ONLY on a real green run) ---------------------------
# Acceptance-bar clause 3 (docs/e2e-matrix.md) — via the SHARED writer.
sh test/e2e/write-receipt.sh "$ART" "$UDID" "test/e2e/run-ios-agent-flow.sh" \
  "Agent-flow E2E: prompt override asserted on the wire + skills discovered from the staged dir and loaded through the real skill tool over the vendored skill family, one-to-one against the agent-flow manifest" \
  "-dsh-mode session -dsh-scenario agent-flow; host-side mock self-started" \
  agent-flow
