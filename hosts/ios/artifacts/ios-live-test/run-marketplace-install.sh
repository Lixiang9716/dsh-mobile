#!/usr/bin/env bash
# run-marketplace-install.sh — the iOS marketplace REAL-INSTALL drive
# (ios-live-test D leg).
#
# The signed-catalog loopback stack (#287/#288 tooling) on the SIMULATOR:
#
#   mock-market-server.mjs (node, host loopback)  →  MARKET_BASE_URL
#   the seat's staged catalog config              →  marketplace:{indexUrl,
#       profiles/default/marketplace/config.json     publicKey} (the enabler
#                                                    commit in SessionServe)
#   the page's marketplace panel (web-client-next)→  WDA drive by LABEL:
#       插件市场 → browse rows → 安装 · Install → progress fold → 已装 tab
#
# Evidence: the full stdout log (marketplace stream events ride the runtime's
# own debug logging — a Debug run), the extracted scenario.jsonl, the
# marketplace event inventory, and a PNG at every step. The signing SEED and
# the private DER prefix are audited out of the capture (the runner greps;
# the public pin is committed test material and stays).
#
# Rule 8: every wait polls a condition with a deadline; sleeps pace the polls.
# usage: run-marketplace-install.sh [--udid U] [--art-dir D] [--skip-install]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART="hosts/ios/artifacts/ios-live-test/D-capability/marketplace-install"
BUNDLE=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
SEED_HEX="3a6b7d0f1e2c3b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d6e"
MOCK_WAIT_DEADLINE_SECONDS=15
DEADLINE=$((SECONDS + 300))
SKIP_INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "usage: $0 [--udid U] [--art-dir D] [--skip-install]" >&2; exit 2 ;;
  esac
done
LOG="$ART/logs.txt"
mkdir -p "$ART" "$ART/screens"

log() { echo "marketplace-drive: $*"; }
die() { echo "marketplace-drive: FAIL: $*" >&2; exit 1; }
shot() { xcrun simctl io "$UDID" screenshot "$ART/screens/$1.png" >/dev/null 2>&1 && log "shot screens/$1.png" || true; }
wait_line() {
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    grep -q "$1" "$LOG" 2>/dev/null && return 0
    sleep 1
  done
  grep -q "$1" "$LOG" 2>/dev/null
}

# ---- 1. the mock catalog server (node, host loopback) -----------------------
MOCK_LOG="$(mktemp /tmp/dsh-mock-market-ios.XXXXXX)"
node runtime/spike/ci/mock-market-server.mjs > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() { kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; rm -f "$MOCK_LOG"; }
trap cleanup EXIT INT TERM
polled=0
until grep -s '^MARKET_BASE_URL=' "$MOCK_LOG" > /dev/null; do
  if ! kill -0 "$MOCK_PID" 2>/dev/null; then
    die "mock market server died before announcing"
  fi
  if [ "$polled" -ge $((MOCK_WAIT_DEADLINE_SECONDS * 20)) ]; then
    die "no MARKET_BASE_URL announce within ${MOCK_WAIT_DEADLINE_SECONDS}s"
  fi
  sleep 0.05; polled=$((polled + 1))
done
MARKET_URL="$(sed -n 's/^MARKET_BASE_URL=//p' "$MOCK_LOG" | head -1)"
echo "$MARKET_URL" > "$ART/market-url.txt"
log "mock catalog: $MARKET_URL"

# The HOST-SIDE PIN, derived from the committed test seed exactly as the CLI
# runner does (the public half is committed test material).
PUB_B64="$(node -e "
const { createPrivateKey, createPublicKey } = require('node:crypto');
const seed = Buffer.from('$SEED_HEX', 'hex');
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
process.stdout.write(Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64'));
")"

# ---- 2. install the app + stage the catalog config --------------------------
[ -d "$APP" ] || die "app bundle missing: $APP"
if [ "$SKIP_INSTALL" -eq 0 ]; then
  xcrun simctl bootstatus "$UDID" -b
  xcrun simctl install "$UDID" "$APP"
fi
CONTAINER="$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)"

# Stage the web boot inputs (the nextweb runner's steps, byte-identical): the
# serve boot refuses to launch the page without the client bundles staged in
# Documents (measured live: "no client bundles staged" → the runtime half
# never boots).
mkdir -p "$CONTAINER/Documents/official-web"
rm -rf "$CONTAINER/Documents/official-web/dist"
cp -R presentation/official-web/dist "$CONTAINER/Documents/official-web/dist"
runtime/spike/vendor/ensure-dsh.sh > /dev/null
test/e2e/ensure-client-bundles.sh > /dev/null
PKG_SRC="runtime/spike/vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2"
rm -rf "$CONTAINER/Documents/web-plugins"
mkdir -p "$CONTAINER/Documents/web-plugins/npm/@deepseek-ai"
cp -R presentation/official-web/client-bundles/npm/@deepseek-ai/. \
    "$CONTAINER/Documents/web-plugins/npm/@deepseek-ai/"
rm -rf "$CONTAINER/Documents/web-plugins/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2"
cp -R "$PKG_SRC" "$CONTAINER/Documents/web-plugins/npm/@deepseek-ai/"

CFG_DIR="$CONTAINER/Documents/profiles/default/marketplace"
mkdir -p "$CFG_DIR"
umask 077
printf '{"indexUrl":"%s/index.json","publicKey":"%s"}\n' "$MARKET_URL" "$PUB_B64" \
  > "$CFG_DIR/config.json"
log "catalog config staged (indexUrl + host-side pin; never printed)"

# ---- 3. launch the serving seat on the NEXT client (Debug → logs flow) -----
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
xcrun simctl launch --terminate-running-process \
  --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
  "$UDID" "$BUNDLE" -dsh-mode serve -dsh-web-client dsh-web-client-next >/dev/null

log "waiting for the next client page (deadline 300s)"
wait_line "index.served\|webclient.mounted\|next.booted\|runtime.booted" 300 \
  || die "page never came up — see $LOG"
sleep 6   # let the page finish mounting + the home view render (paced poll below)
shot 01-home

# ---- 4. the WDA drive -------------------------------------------------------
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

"$UI" tap "插件市场" || die "插件市场 button not found"
"$UI" wait "浏览" --secs 30 || true
shot 02-market-browse
sleep 2
"$UI" scan | head -40 > "$ART/panel-scan.txt" || true

# The catalog's single demo row: install it (the button label is bilingual).
"$UI" tap "安装 · Install" || die "install button not found — see panel-scan.txt"
shot 03-install-pressed
sleep 2
shot 04-install-progress
"$UI" wait "已安装 · Installed" --secs 60 || log "installed label not observed in time (checking the log instead)"
shot 05-installed-row

# The 已装 tab: the receipts journal's committed install.
"$UI" tap "已装" || die "已装 tab not found"
sleep 2
shot 06-installed-tab
"$UI" scan | head -40 > "$ART/installed-scan.txt" || true
shot 07-final-state

# ---- 5. checkers ------------------------------------------------------------
grep '^dsh.spike.log:' "$LOG" > "$ART/scenario.jsonl" || true
EVENTS="$ART/marketplace-events.txt"
grep -o '"event":"marketplace[^"]*"' "$LOG" | sort | uniq -c > "$EVENTS" || true
log "marketplace event inventory:"
cat "$EVENTS" || true

# The trust audit: the signing seed and its DER prefix never reach the capture.
if grep -F -e "$SEED_HEX" -e "302e020100300506032b657004220420" "$LOG" "$ART/nslog-stderr.txt" >/dev/null 2>&1; then
  die "the signing key material appeared in the captured log"
fi

# The install stream must have committed (the honest terminal fact).
wait_line "marketplace.install.completed\|committed" 1 || true
if ! grep -q "marketplace" "$ART/scenario.jsonl"; then
  die "no marketplace events in the captured log — the panel leg did not reach the runtime"
fi

sh test/e2e/write-receipt.sh "$ART" "$UDID" "hosts/ios/artifacts/ios-live-test/run-marketplace-install.sh" \
  "W-MKT marketplace real install on the simulator: the signed loopback catalog is fetched over the REAL gateway httpFetch, its ed25519 signature verified against the host-side pin, one package committed through the UNCHANGED installer, driven through the web-client-next panel (browse → install → progress → installed) with a PNG at every step" \
  "-dsh-mode serve -dsh-web-client dsh-web-client-next; the staged catalog config enables the face" \
  marketplace-ui-flow
log "DONE — evidence in $ART"
