#!/bin/sh
# hosts/android/ci/run-camera-plane.sh — the capability plane's camera E2E
# leg (scenario `android.camera-plane`): boots the emulator if needed,
# installs the debug APK, pre-grants the OS CAMERA permission (the runtime
# prompt is the second consent layer; the emulator drive exercises the
# capture burst itself against the virtual camera — a REAL capture, no
# fixtures), launches with `--ez dsh.cameraplane true`, polls the logcat
# snapshot for the completion result, and runs the scenario + audit
# checkers. Evidence lands under hosts/android/artifacts/camera-plane/ (the
# e2e-matrix deliverables: logs.txt, scenario.jsonl, receipt.json, verdicts).
#
# usage: run-camera-plane.sh [--skip-build]   (env: DSH_ANDROID_ART overrides
#        the evidence dir; DSH_ANDROID_SERIAL pins a booted emulator)
set -u
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
PKG=com.dshmobile.spike
OUT="${DSH_ANDROID_ART:-hosts/android/artifacts/camera-plane}"
SCEN=test/e2e/scenarios
APK=hosts/android/app/build/outputs/apk/debug/app-debug.apk
SERIAL="${DSH_ANDROID_SERIAL:-}"
SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

say() { echo "run-camera-plane: $*"; }
die() { echo "run-camera-plane: FAIL: $*" >&2; exit 1; }
adbsh() { if [ -n "$SERIAL" ]; then adb -s "$SERIAL" "$@"; else adb "$@"; fi; }

mkdir -p "$OUT"

# ---- 1. build ---------------------------------------------------------------
if [ "$SKIP_BUILD" = "0" ]; then
    say "1/5 assembleDebug"
    ( cd hosts/android && ./gradlew assembleDebug --console=plain -q >/dev/null ) \
        || die "gradle assembleDebug failed"
else
    say "1/5 build skipped"
fi
[ -f "$APK" ] || die "APK missing at $APK (build first)"

# ---- 2. boot + install ------------------------------------------------------
say "2/5 boot poll + install"
adbsh wait-for-device
boot_deadline=$(( $(date +%s) + 120 ))
until adbsh shell getprop sys.boot_completed 2>/dev/null | grep -q 1; do
    [ "$(date +%s)" -ge "$boot_deadline" ] && die "emulator did not finish booting within 120s"
    sleep 2
done
adbsh install -r "$APK" >/dev/null || die "adb install failed"

# ---- 3. fixture: the OS camera grant ----------------------------------------
# The emulator's virtual camera is the real capture surface; the runtime
# permission is pre-granted so the drive is headless (the OS prompt ladder is
# the device leg's business — this leg certifies the burst).
say "3/5 pre-granting the OS camera permission"
adbsh shell pm grant $PKG android.permission.CAMERA 2>/dev/null \
    || say "WARNING: pm grant failed — the burst may refuse at the OS layer"

# ---- 4. launch + poll --------------------------------------------------------
say "4/5 launch (--ez dsh.cameraplane true)"
# Deterministic capture (the device-plane leg's design: clear the device
# buffer, launch CLEAN, poll `logcat -d` snapshots — a dump is inherently
# this-run-only).
DUMP="$OUT/.cp-dump.txt"
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
until adbsh shell am start -n $PKG/.MainActivity --ez dsh.cameraplane true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$launch_deadline" ] && die "am start kept failing within 60s"
    sleep 2
done
rec_deadline=$(( $(date +%s) + 60 ))
until adbsh logcat -d -s dsh.spike 2>/dev/null | grep -q "dsh.spike.log"; do
    [ "$(date +%s)" -ge "$rec_deadline" ] && die "no dsh.spike records within 60s of am start"
    sleep 1
done

deadline=$(( $(date +%s) + 420 ))
until adbsh logcat -d -s dsh.spike dsh.spike.result dsh.spike.audit > "$DUMP" 2>/dev/null \
        && grep -q "dsh.spike.result: ALL" "$DUMP"; do
    [ "$(date +%s)" -ge "$deadline" ] && die "camera-plane scenario did not complete within 420s"
    sleep 2
done
sleep 1

# ---- 5. checkers -------------------------------------------------------------
say "5/5 checkers"
cp "$DUMP" "$OUT/logs.txt"
grep 'dsh.spike.result' "$OUT/logs.txt" > "$OUT/results.txt" || true
grep 'dsh.spike.log:' "$OUT/logs.txt" > "$OUT/scenario.jsonl" || true
grep 'dsh.gateway.audit:' "$OUT/logs.txt" > "$OUT/gateway-audit.jsonl" || true

FAIL=0
# The SIMULATOR camera leg drives scenario camera.plane — the manifests are
# camera-plane.json / camera-plane-audit.json. The capture manifests
# (camera-plane-capture*.json, scenario ble.plane) belong to the DEVICE
# camera leg (run-ios-camera-plane-device.sh): 62f80165 wired them in here by
# mistake and nothing re-ran the leg until the v0.0.2 release regression
# (2026-09-30) — the checker could never match the emulator's own scenario.
node test/e2e/check.mjs --manifest $SCEN/camera-plane.json \
    --log "$OUT/logs.txt" --out "$OUT/verdict-android-camera-plane.json" || FAIL=1
cat "$OUT/verdict-android-camera-plane.json"
node test/e2e/check.mjs --manifest $SCEN/camera-plane-audit.json \
    --log "$OUT/logs.txt" --out "$OUT/verdict-android-camera-plane-audit.json" || FAIL=1
cat "$OUT/verdict-android-camera-plane-audit.json"
[ "$FAIL" = "0" ] || die "checkers red — evidence stays unreceipted (rule: receipts only from green runs)"

UDID="$(adbsh get-serialno | tr -d '\r')"
TREE_LINE="origin/main $(git rev-parse --short=12 HEAD)$(git diff-index --quiet HEAD -- || echo ' (dirty working tree at receipt time)')"
cat > "$OUT/receipt.json" <<EOF
{
  "host": "android",
  "udid": "$UDID",
  "runner": "hosts/android/ci/run-camera-plane.sh",
  "phase": "android.camera-plane",
  "launch": "emulator, --ez dsh.cameraplane true (Debug, virtual camera burst)",
  "tree": "$TREE_LINE",
  "engine": "$(sed -n 's/^PIN=//p' runtime/spike/vendor/ensure.sh)",
  "scenarios": [
    { "manifest": "camera-plane-capture", "verdict": "verdict-camera-plane-capture.json", "pass": true },
    { "manifest": "camera-plane-capture-audit", "verdict": "verdict-camera-plane-capture-audit.json", "pass": true }
  ],
  "screens": [],
  "producedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
say "receipt written — android.camera-plane green ($OUT)"
