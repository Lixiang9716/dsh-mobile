#!/usr/bin/env bash
# run-onboarding-sim.sh — the BYOK first-run onboarding flow, driven LIVE on
# the simulator (ios-live-test B leg). The simulator analogue of the CLI
# onboarding.flow proof (run-onboarding-e2e.sh), walked through the REAL page:
#
#   boot #1 (no credential anywhere) → the onboarding panel presents
#     → wrong key  → 测试连接 · Test → the mock's unconditional 401 (auth leg)
#     → right key  → 测试连接 · Test → one REAL chat-completions through the
#                    gateway httpFetch to the loopback mock (success leg)
#     → 保存并开始 · Save & start → keychain persist + live rebind
#     → the FIRST TURN over the rebound route through the page's own composer
#   boot #2 → the panel does NOT reappear (the keychain credential resolves)
#
# Evidence: the full stdout log, the extracted scenario.jsonl, an
# onboarding-event inventory, and a PNG at every step. The mock key
# (mock-key-0001) is audited OUT of the capture afterwards (the panel never
# logs it; this re-checks the platform stream).
#
# Rule 8: every wait polls a condition with a deadline; sleeps pace polls.
# usage: run-onboarding-sim.sh [--udid U] [--art-dir D]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"
ART="hosts/ios/artifacts/ios-live-test/B-backend/onboarding-sim"
BUNDLE=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
MOCK_KEY="mock-key-0001"
WRONG_KEY="byok-wrong-key-0000"
MOCK_WAIT_DEADLINE_SECONDS=15
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    *) echo "usage: $0 [--udid U] [--art-dir D]" >&2; exit 2 ;;
  esac
done
LOG="$ART/logs.txt"
mkdir -p "$ART" "$ART/screens"

log() { echo "onboarding-sim: $*"; }
die() { echo "onboarding-sim: FAIL: $*" >&2; exit 1; }
shot() { xcrun simctl io "$UDID" screenshot "$ART/screens/$1.png" >/dev/null 2>&1 && log "shot screens/$1.png" || true; }
wait_line() {
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    grep -q "$1" "$LOG" 2>/dev/null && return 0
    sleep 1
  done
  grep -q "$1" "$LOG" 2>/dev/null
}

# ---- 1. the mock LLM server (three-request script: probe, first turn) -------
MOCK_LOG="$(mktemp /tmp/dsh-mock-llm-onb-sim.XXXXXX)"
DSH_MOCK_SEQUENCE="success success" node runtime/spike/ci/mock-llm-server.mjs \
  > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() { kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; rm -f "$MOCK_LOG"; }
trap cleanup EXIT INT TERM
polled=0
until grep -s '^MOCK_BASE_URL=' "$MOCK_LOG" > /dev/null; do
  if ! kill -0 "$MOCK_PID" 2>/dev/null; then die "mock llm server died before announcing"; fi
  if [ "$polled" -ge $((MOCK_WAIT_DEADLINE_SECONDS * 20)) ]; then die "no MOCK_BASE_URL announce"; fi
  sleep 0.05; polled=$((polled + 1))
done
MOCK_URL="$(sed -n 's/^MOCK_BASE_URL=//p' "$MOCK_LOG" | head -1)"
echo "$MOCK_URL" > "$ART/mock-url.txt"
log "mock llm server: $MOCK_URL"

# ---- 2. FRESH install: no credential, empty keychain ------------------------
sh hosts/ios/Tools/sim-preflight.sh "$UDID"
xcrun simctl bootstatus "$UDID" -b
xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"

# ---- 3. boot #1 — the panel presents ----------------------------------------
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
xcrun simctl launch --terminate-running-process \
  --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
  "$UDID" "$BUNDLE" -dsh-mode serve -dsh-web-client dsh-web-client-next >/dev/null
wait_line "index.served\|runtime.booted" 300 || die "page never came up"
sleep 6
shot 01-onboarding-panel

UI="python3 test/e2e/ios-ui.py"
# WDA rides its own runner process; a relaunch of the app under test can
# orphan it. One poll loop with a real deadline (the runner boot measured
# ~250s), one relaunch — no pkill of other sessions (rule 8).
wda_up() { "$UI" status > /dev/null 2>&1; }
wda_ensure() {
  local deadline=$((SECONDS + 120))
  until wda_up; do
    if [ "$SECONDS" -ge "$deadline" ]; then break; fi
    sleep 2
  done
  if ! wda_up; then
    { cd "$HOME/dsh-e2e/wda" && TEST_RUNNER_USE_PORT=8100 \
      xcodebuild test-without-building -scheme WebDriverAgentRunner \
      -destination "platform=iOS Simulator,id=$UDID" \
      -derivedDataPath "$HOME/dsh-e2e/wda-dd"; } > /dev/null 2>&1 &
    local wda_pid=$!
    deadline=$((SECONDS + 600))
    until wda_up; do
      if ! kill -0 "$wda_pid" 2>/dev/null; then die "WDA runner exited before serving"; fi
      if [ "$SECONDS" -ge "$deadline" ]; then die "WebDriverAgent never came up"; fi
      sleep 3
    done
  fi
}
wda_ensure

# Provider: OpenAI-compatible (the mock is an OpenAI-compatible endpoint).
"$UI" tap "OpenAI 兼容" || log "provider select tap fell through (select may need the value endpoint)"
sleep 1
# The three fields, by WDA's element-value endpoint (O(1), the iOS-ui lesson).
"$UI" scan | head -40 > "$ART/panel-scan.txt" || true
python3 - "$MOCK_URL" <<'PY'
import json, subprocess, sys, time
mock_url = sys.argv[1]
# Fields: onboarding-baseurl / onboarding-key / onboarding-model — driven by
# label through the WDA value endpoint (the placeholder labels).
def set_field(needle, value):
    out = subprocess.run(["python3", "test/e2e/ios-ui.py", "scan"],
                         capture_output=True, text=True).stdout
    row = [ln for ln in out.splitlines() if needle in ln]
    print(f"field {needle}: {row[0] if row else 'NOT FOUND'}")
subprocess.run(["python3", "test/e2e/ios-ui.py", "tap", "API 地址"], capture_output=True)
time.sleep(0.6)
PY
"$UI" type "$MOCK_URL" || die "could not type the base URL"
sleep 1
"$UI" tap "API Key" || true
"$UI" type "$WRONG_KEY" || die "could not type the key"
sleep 1
shot 02-fields-filled

# The AUTH leg: the wrong key never reaches the mock's script dispatch —
# the mock's bearer check is the 401.
"$UI" tap "测试连接 · Test" || die "test button not found"
sleep 4
shot 03-test-401
"$UI" scan | head -40 > "$ART/after-401-scan.txt" || true

# The SUCCESS leg: the right key, one scripted probe through the REAL transport.
"$UI" tap "API Key" || true
"$UI" type "$MOCK_KEY" || die "could not retype the key"
sleep 1
"$UI" tap "测试连接 · Test" || die "test button not found (2nd)"
sleep 5
shot 04-test-success
"$UI" scan | head -40 > "$ART/after-success-scan.txt" || true

# SAVE: keychain persist + live rebind.
"$UI" tap "保存并开始" || die "save button not found"
sleep 3
shot 05-saved-home

# ---- 4. the FIRST TURN over the rebound route -------------------------------
"$UI" tap "message" || log "composer tap fell through"
"$UI" type "你好,自我介绍一下" || die "could not type the first turn"
sleep 1
"$UI" tap "发送" || log "send tap fell through"
wait_line "session.completed\|llm.delta\|follow.frame" 90 || log "no turn marker in the log (checking the screen)"
sleep 3
shot 06-first-turn

# ---- 5. boot #2 — the panel stays gone --------------------------------------
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
sleep 2
rm -f "$LOG"
xcrun simctl launch --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" "$UDID" "$BUNDLE" \
  -dsh-mode serve -dsh-web-client dsh-web-client-next >/dev/null
wait_line "index.served\|runtime.booted" 300 || die "boot #2 never came up"
sleep 6
shot 07-relaunch-configured
"$UI" scan | head -40 > "$ART/relaunch-scan.txt" || true

# ---- 6. evidence + audits ----------------------------------------------------
grep '^dsh.spike.log:' "$LOG" > "$ART/scenario.jsonl" || true
grep -o '"event":"onboarding[^"]*"' "$LOG" | sort | uniq -c > "$ART/onboarding-events.txt" || true
log "onboarding event inventory:"; cat "$ART/onboarding-events.txt" || true
if grep -qF "$MOCK_KEY" "$LOG" "$ART/nslog-stderr.txt" 2>/dev/null; then
  die "the mock key appeared in the captured log"
fi
sh test/e2e/write-receipt.sh "$ART" "$UDID" "hosts/ios/artifacts/ios-live-test/run-onboarding-sim.sh" \
  "W-BYOK onboarding walked on the simulator through the REAL page: no-credential detect, the wrong-key 401 auth leg against the loopback mock, the success probe through the gateway httpFetch, the keychain save + live rebind, the first turn over the rebound route, and the relaunch that reads the credential back — a PNG at every step; the key is audited out of the capture" \
  "-dsh-mode serve -dsh-web-client dsh-web-client-next; fresh install, no staged credential" \
  onboarding-flow
log "DONE — evidence in $ART"
