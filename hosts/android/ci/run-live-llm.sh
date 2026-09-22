#!/bin/sh
# run-live-llm.sh — the REAL-backend LLM E2E on the Android emulator (scenario
# `llm.live-stream`, real leg). Sibling of hosts/android/ci/run-spike-e2e.sh (same
# capture discipline: launch exactly ONCE, stream the log, bound the capture
# at the first completion tag) with the LLM steps added:
#
#   1. stage the LLM credentials into fs scope "app"
#      (files/profiles/default/llm-live-stream/config.json via run-as — the key is
#      written to the app container only, never echoed, never committed);
#   2. launch with `--ez dsh.llm true` (SpikeHostM4.startLlm — scenario
#      `llm.live-stream`, entry scenario/llm-live-stream.js, one real streaming chat turn
#      through the gateway httpFetch);
#   3. verify the captured log against llm-live-stream-device.json AND
#      llm-live-stream-carrier.json, then grep the raw stream for the API key —
#      the key must appear NOWHERE.
#
# Every wait is a polled condition with a deadline (rules.md rule 8); every
# exhaustion is loud (rule 5).
set -eu

PKG=com.dshmobile.spike
APK=hosts/android/app/build/outputs/apk/debug/app-debug.apk
OUT=${DSH_M2_LLM_OUT:-hosts/android/artifacts/llm-live-stream}
STREAM=$OUT/dsh-llm-live-stream-stream.txt

say() { echo "run-live-llm: $*"; }
die() { echo "::error::run-live-llm: $*" >&2; exit 1; }

# ---- credentials (env or repo-root .env; fail loud, never print) -----------
if [ -z "${ZAI_API_KEY:-}" ] && [ -f .env ]; then
    . ./.env
fi
[ -n "${ZAI_BASE_URL:-}" ] || die "ZAI_BASE_URL missing (env or .env)"
[ -n "${ZAI_API_KEY:-}" ] || die "ZAI_API_KEY missing (env or .env)"
[ -n "${ZAI_MODEL:-}" ] || die "ZAI_MODEL missing (env or .env)"

mkdir -p "$OUT"

# ---- device + boot, one bounded poll ----------------------------------------
deadline=$(( $(date +%s) + 600 ))
until adb get-state >/dev/null 2>&1 &&
      [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    if ! pgrep -f "emulator" >/dev/null 2>&1; then
        die "emulator process is gone — boot never started or died"
    fi
    [ "$(date +%s)" -ge "$deadline" ] && die "emulator did not finish booting within 600s"
    sleep 5
done

until adb install -r "$APK" 2>/dev/null; do
    tries=$(( tries + 1 ))
    [ "$tries" -ge 5 ] && die "adb install kept failing after boot"
    sleep 3
done

# ---- stage credentials into fs scope "app" ----------------------------------
# The reserved app scope maps to <filesDir>/profiles/default (FsPrimitives.kt).
# materializeBundle only re-copies assets UNDER filesDir/spike, so the staged
# config survives relaunches.
CFG=$(mktemp "${TMPDIR:-/tmp}/dsh-llm-live-stream-config.XXXXXX")
chmod 600 "$CFG"
printf '{"baseUrl":"%s","apiKey":"%s","model":"%s"}\n' \
    "$ZAI_BASE_URL" "$ZAI_API_KEY" "$ZAI_MODEL" > "$CFG"
adb shell "run-as $PKG sh -c 'mkdir -p files/profiles/default/llm-live-stream && cat > files/profiles/default/llm-live-stream/config.json'" < "$CFG"
adb shell "run-as $PKG cat files/profiles/default/llm-live-stream/config.json" | grep -q '"apiKey"' \
    || die "config staging failed (apiKey not found in the staged file)"
rm -f "$CFG"
say "credentials staged into the app container (never printed)"

# ---- launch + bounded log capture -------------------------------------------
adb shell am force-stop $PKG >/dev/null 2>&1 || true
adb logcat -c
: > "$STREAM"
adb logcat -s dsh.spike dsh.spike.result > "$STREAM" 2>/dev/null &
streamer=$!
cleanup() {
    kill "$streamer" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

deadline=$(( $(date +%s) + 60 ))
until adb shell am start -n $PKG/.MainActivity --ez dsh.llm true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "am start kept failing within 60s"
    sleep 2
done

deadline=$(( $(date +%s) + 300 ))
until grep -q "dsh.spike.result: ALL" "$STREAM"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "::error::llm.live-stream session did not complete within 300s"
        tail -80 "$STREAM"
        exit 1
    fi
    sleep 0.2
done
sleep 0.3          # let the completion-tag line itself flush
trap - EXIT
cleanup

sed '/dsh.spike.result: ALL/q' "$STREAM" > "$OUT/logs.txt"
grep 'dsh.spike.result' "$OUT/logs.txt" > "$OUT/results.txt"
cat "$OUT/results.txt"
grep 'dsh.spike.log:' "$OUT/logs.txt" > "$OUT/scenario.jsonl" || true

# ---- the key-leak re-check over the RAW captured stream ----------------------
if grep -qF "$ZAI_API_KEY" "$OUT/logs.txt"; then
    die "THE API KEY APPEARED IN THE CAPTURED LOG"
fi
say "key-leak re-check clean (raw log stream carries no API key)"

# ---- E2E by logs: one checker verdict per manifest ---------------------------
node test/e2e/check.mjs --manifest test/e2e/scenarios/llm-live-stream-device.json \
    --log "$OUT/logs.txt" --out "$OUT/verdict-llm-live-stream-device.json"
cat "$OUT/verdict-llm-live-stream-device.json"
node test/e2e/check.mjs --manifest test/e2e/scenarios/llm-live-stream-carrier.json \
    --log "$OUT/logs.txt" --out "$OUT/verdict-llm-live-stream-carrier.json"
cat "$OUT/verdict-llm-live-stream-carrier.json"
say "llm.live-stream real-backend leg complete — evidence under $OUT"
