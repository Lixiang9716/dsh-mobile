#!/bin/sh
# hosts/android/ci/run-mic-plane.sh — the capability plane's microphone E2E
# leg (scenario `android.mic-plane`): boots the emulator if needed, installs
# the debug APK, PRE-GRANTS the OS mic permission (the honest automation of
# the second consent layer: `adb pm grant` — the request path still runs
# host-side and answers granted without a dialog), launches with
# `--ez dsh.micplane true`, polls the deterministic logcat snapshot until
# the completion tag, and runs the scenario + audit checkers. The
# emulator's mic routes to the host input, so real PCM frames flow (honest
# frames, no fixtures). Evidence lands under hosts/android/artifacts/
# mic-plane/ (the e2e-matrix deliverables).
#
# usage: run-mic-plane.sh [--skip-build]   (env: DSH_ANDROID_ART overrides
#        the evidence dir; DSH_ANDROID_SERIAL pins a booted emulator)
set -u
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT" || exit 1
PKG=com.dshmobile.spike
OUT="${DSH_ANDROID_ART:-hosts/android/artifacts/mic-plane}"
SCEN=test/e2e/scenarios
APK=hosts/android/app/build/outputs/apk/debug/app-debug.apk
SERIAL="${DSH_ANDROID_SERIAL:-}"
SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

say() { echo "run-mic-plane: $*"; }
die() { echo "run-mic-plane: FAIL: $*" >&2; exit 1; }
shot() { adb $SERIAL shell screencap -p /sdcard/dsh-shot.png >/dev/null 2>&1 && adb $SERIAL pull /sdcard/dsh-shot.png "$OUT/screens/$1.png" >/dev/null 2>&1 || true; }
adbsh() { if [ -n "$SERIAL" ]; then adb -s "$SERIAL" "$@"; else adb "$@"; fi; }

mkdir -p "$OUT/screens"

# ---- 1. build ---------------------------------------------------------------
if [ "$SKIP_BUILD" = "0" ]; then
    say "1/5 assembleDebug"
    ( cd hosts/android && ./gradlew assembleDebug --console=plain -q >/dev/null ) \
        || die "gradle assembleDebug failed"
else
    say "1/5 build skipped"
fi
[ -f "$APK" ] || die "APK missing at $APK (build first)"

# ---- 2. boot + install + the honest OS-grant automation ---------------------
say "2/5 boot poll + install + pre-grant RECORD_AUDIO"
adbsh wait-for-device
boot_deadline=$(( $(date +%s) + 120 ))
until adbsh shell getprop sys.boot_completed 2>/dev/null | grep -q 1; do
    [ "$(date +%s)" -ge "$boot_deadline" ] && die "emulator did not finish booting within 120s"
    sleep 2
done
adbsh install -r "$APK" >/dev/null || die "adb install failed"
adbsh shell pm grant $PKG android.permission.RECORD_AUDIO >/dev/null 2>&1 \
    || die "pm grant RECORD_AUDIO failed (debug builds are grantable — is this a release APK?)"
say "RECORD_AUDIO pre-granted to $PKG (automation, recorded)"

# ---- 3. launch ---------------------------------------------------------------
say "3/5 launch (--ez dsh.micplane true)"
# Deterministic capture (the device-plane runner's posture): clear the
# device buffer, launch CLEAN, poll `logcat -d` snapshots — a dump is
# inherently this-run-only.
DUMP="$OUT/.mp-dump.txt"
: > "$DUMP"
adbsh shell am force-stop $PKG >/dev/null 2>&1 || true
stop_deadline=$(( $(date +%s) + 30 ))
while [ -n "$(adbsh shell pidof $PKG 2>/dev/null | tr -d '[:space:]')" ]; do
    [ "$(date +%s)" -ge "$stop_deadline" ] && die "force-stop left $PKG resident"
    adbsh shell am force-stop $PKG >/dev/null 2>&1 || true
    sleep 1
done
adbsh logcat -c

launch_deadline=$(( $(date +%s) + 60 ))
until adbsh shell am start -n $PKG/.MainActivity --ez dsh.micplane true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$launch_deadline" ] && die "am start kept failing within 60s"
    sleep 2
done
rec_deadline=$(( $(date +%s) + 60 ))
until adbsh logcat -d -s dsh.spike 2>/dev/null | grep -q "dsh.spike.log"; do
    [ "$(date +%s)" -ge "$rec_deadline" ] && die "no dsh.spike records within 60s of am start"
    sleep 1
done

# ---- 4. wait for the verdict -------------------------------------------------
snapshot() { adbsh logcat -d -s dsh.spike dsh.spike.result dsh.spike.ui dsh.spike.audit > "$DUMP" 2>/dev/null; }

deadline=$(( $(date +%s) + 300 ))
until snapshot && grep -q "dsh.spike.result: ALL" "$DUMP"; do
    [ "$(date +%s)" -ge "$deadline" ] && { tail -80 "$DUMP"; die "mic-plane scenario did not complete within 300s"; }
    sleep 1
done
sleep 1

# ---- 5. checkers -------------------------------------------------------------
say "5/5 checkers"
cp "$DUMP" "$OUT/logs.txt"
grep 'dsh.spike.result' "$OUT/logs.txt" > "$OUT/results.txt" || true
grep 'dsh.spike.log:' "$OUT/logs.txt" > "$OUT/scenario.jsonl" || true
grep 'dsh.gateway.audit:' "$OUT/logs.txt" > "$OUT/gateway-audit.jsonl" || true
shot 01-final

FAIL=0
node test/e2e/check.mjs --manifest $SCEN/android-mic-plane.json \
    --log "$OUT/logs.txt" --out "$OUT/verdict-android-mic-plane.json" || FAIL=1
cat "$OUT/verdict-android-mic-plane.json"
node test/e2e/check.mjs --manifest $SCEN/android-mic-plane-audit.json \
    --log "$OUT/logs.txt" --out "$OUT/verdict-android-mic-plane-audit.json" || FAIL=1
cat "$OUT/verdict-android-mic-plane-audit.json"
[ "$FAIL" = "0" ] || die "checkers red — evidence stays unreceipted (rule: receipts only from green runs)"

UDID="$(adbsh get-serialno | tr -d '\r')"
TREE_LINE="origin/main $(git rev-parse --short=12 HEAD)$(git diff-index --quiet HEAD -- || echo ' (dirty working tree at receipt time)')"
cat > "$OUT/receipt.json" <<EOF
{
  "host": "android",
  "udid": "$UDID",
  "runner": "hosts/android/ci/run-mic-plane.sh",
  "phase": "android.mic-plane",
  "launch": "emulator, --ez dsh.micplane true (Debug, RECORD_AUDIO pre-granted)",
  "tree": "$TREE_LINE",
  "engine": "$(sed -n 's/^PIN=//p' runtime/spike/vendor/ensure.sh)",
  "scenarios": [
    { "manifest": "android-mic-plane", "verdict": "verdict-android-mic-plane.json", "pass": true },
    { "manifest": "android-mic-plane-audit", "verdict": "verdict-android-mic-plane-audit.json", "pass": true }
  ],
  "screens": ["screens/01-final.png"],
  "producedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
say "receipt written — android.mic-plane green ($OUT)"
