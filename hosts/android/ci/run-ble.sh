#!/bin/sh
# hosts/android/ci/run-ble.sh — the capability plane's BLE-face E2E leg on
# the Android emulator (scenario `android.ble-plane`): boots nothing (the
# emulator is already up or DSH_ANDROID_SERIAL pins it), installs the debug
# APK, launches with `--ez dsh.ble true [--ez dsh.blemock true]`, polls
# logcat snapshots (the run-device-plane capture discipline), and runs the
# scenario + audit checkers. Evidence under hosts/android/artifacts/ble-<mode>/
# (the e2e-matrix deliverables). CI-runnable in mock mode (no radio needed).
#
# usage: run-ble.sh [skip|mock|device] [--skip-build]
#   skip   the real radio posture — the emulator answers the OS layer's
#          `denied` honestly (virtual controller up, runtime permissions
#          ungranted): the honest skip leg.
#   mock   the deterministic mock radio — the full GATT ladder through the
#          REAL gateway enforcement and audit (the CI leg).
#   device D-g: a REAL device (DSH_ANDROID_SERIAL) with a peer advertising
#          the test GATT db (180f/2a19 read+notify, fe00/fe01 write — e.g.
#          a second phone running a BLE-peripheral simulator with those
#          UUIDs). Refuses an emulator serial — never fakes evidence.
set -u
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT" || exit 1
PKG=com.dshmobile.spike
MODE="${1:-skip}"
SKIP_BUILD=0
[ "${2:-}" = "--skip-build" ] && SKIP_BUILD=1

SERIAL="${DSH_ANDROID_SERIAL:-}"
adbsh() { if [ -n "$SERIAL" ]; then adb -s "$SERIAL" "$@"; else adb "$@"; fi; }
say() { echo "run-ble: $*"; }
die() { echo "run-ble: FAIL: $*" >&2; exit 1; }

case "$MODE" in
  skip)  EXTRAS="--ez dsh.ble true";                              SCEN="android-ble" ;;
  mock)  EXTRAS="--ez dsh.ble true --ez dsh.blemock true";        SCEN="android-ble-mock" ;;
  device)
    [ -n "$SERIAL" ] || die "device mode needs DSH_ANDROID_SERIAL"
    STATE=$(adb -s "$SERIAL" get-state 2>/dev/null || echo gone)
    [ "$STATE" = "device" ] || die "serial $SERIAL is not a live device ($STATE)"
    # D-g honesty gate: an emulator serial is refused — the device leg runs
    # on hardware only, and only against a peer with the test db.
    case "$SERIAL" in
      emulator-*|127.0.0.1:*) die "$SERIAL is an emulator — the device leg refuses to fake hardware evidence" ;;
    esac
    EXTRAS="--ez dsh.ble true";                                    SCEN="android-ble-device" ;;
  *) die "unknown mode $MODE (want skip|mock|device)" ;;
esac
OUT="${DSH_ANDROID_ART:-hosts/android/artifacts/ble-$MODE}"
SCEN_DIR=test/e2e/scenarios
APK=hosts/android/app/build/outputs/apk/debug/app-debug.apk
mkdir -p "$OUT/screens"

if [ "$SKIP_BUILD" = "0" ]; then
    say "1/5 assembleDebug"
    ( cd hosts/android && ./gradlew assembleDebug --console=plain -q >/dev/null ) \
        || die "gradle assembleDebug failed"
else
    say "1/5 build skipped"
fi
[ -f "$APK" ] || die "APK missing at $APK (build first)"

say "2/5 install"
# uninstall FIRST: a fresh install resets the runtime permissions, which is
# what pins the skip leg's OS-refused posture deterministically (a reinstall
# -r would KEEP grants and flip the posture to a live scan)
adbsh uninstall $PKG >/dev/null 2>&1 || true

adbsh install -r "$APK" >/dev/null || die "adb install failed"

if [ "$MODE" = "skip" ]; then
    # the unattended skip leg PINS the OS-refused posture deterministically:
    # revoke the runtime pair so the radio layer answers the OS layer's
    # denied (the granted variant arms a real scan whose zero-advertisement
    # wait ends via the scan-end record — the live-empty posture — which is
    # environment-flaky on a virtual controller; the D-g device leg is where
    # the granted radio runs)
    adbsh shell pm revoke $PKG android.permission.BLUETOOTH_SCAN >/dev/null 2>&1 || true
    adbsh shell pm revoke $PKG android.permission.BLUETOOTH_CONNECT >/dev/null 2>&1 || true
fi

if [ "$MODE" != "device" ]; then
    adbsh shell pm grant $PKG android.permission.BLUETOOTH_SCAN >/dev/null 2>&1 \
        || say "pm grant SCAN skipped (pre-31 image — the posture decides)"
    adbsh shell pm grant $PKG android.permission.BLUETOOTH_CONNECT >/dev/null 2>&1 \
        || say "pm grant CONNECT skipped (pre-31 image — the posture decides)"
fi
# The unattended legs pre-grant the API-31+ runtime pair: a granted radio
# arms a REAL scan whose window self-ends at the timeout — the scan-end
# record bounds the zero-advertisement case honestly (the arm/stop
# envelope). The in-app OS-request path (BlePrimitives.ensureRadio) is
# what a real device exercises before any grant exists (the D-g legs).

say "3/5 launch ($EXTRAS)"
DUMP="$OUT/.ble-dump.txt"  # intermediate; never committed
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
# EXTRAS is an am flag bundle ("--ez k v ...") — the split is the contract
# shellcheck disable=SC2086 # intentional word split
until adbsh shell am start -n "$PKG"/.MainActivity $EXTRAS >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$launch_deadline" ] && die "am start kept failing within 60s"
    sleep 2
done
rec_deadline=$(( $(date +%s) + 60 ))
until adbsh logcat -d -s dsh.spike 2>/dev/null | grep -q "dsh.spike.log"; do
    [ "$(date +%s)" -ge "$rec_deadline" ] && die "no dsh.spike records within 60s of am start"
    sleep 1
done

say "4/5 waiting for the completion tag (deadline 300s)"
deadline=$(( $(date +%s) + 300 ))
until adbsh logcat -d -s dsh.spike.result 2>/dev/null | grep -q "dsh.spike.result: ALL"; do
    [ "$(date +%s)" -ge "$deadline" ] && die "ble.plane did not complete within 300s"
    sleep 2
done
sleep 1
adbsh logcat -d -s dsh.spike dsh.spike.result dsh.spike.ui dsh.spike.audit > "$OUT/logs.txt" 2>/dev/null
grep 'dsh.spike.log:' "$OUT/logs.txt" > "$OUT/scenario.jsonl" || true
grep 'dsh.gateway.audit:' "$OUT/logs.txt" > "$OUT/gateway-audit.jsonl" || true

say "5/5 checkers"
rm -f "$OUT"/verdict-*.json   # a prior red run's verdicts must not linger
# the skip posture is OBSERVED (denied: virtual radio up + runtime
# permissions ungranted; absent: no radio at all; live-empty: radio armed
# but the RF room silent — after pm grant, the honest arm/stop envelope)
if [ "$MODE" = "skip" ]; then
    if grep -q '"mode":"absent"' "$OUT/logs.txt"; then
        SCEN="android-ble-absent"
    elif grep -q '"mode":"live"' "$OUT/logs.txt"; then
        SCEN="android-ble-live-empty"
    fi
fi
FAIL=0
node test/e2e/check.mjs --manifest $SCEN_DIR/$SCEN.json \
    --log "$OUT/logs.txt" --out "$OUT/verdict-$SCEN.json" || FAIL=1
if [ "$MODE" != "device" ]; then
    node test/e2e/check.mjs --manifest $SCEN_DIR/$SCEN-audit.json \
        --log "$OUT/logs.txt" --out "$OUT/verdict-$SCEN-audit.json" || FAIL=1
fi
cat "$OUT/verdict-$SCEN.json"
[ "$FAIL" = "0" ] || die "checkers red — evidence stays unreceipted"

UDID="$(adbsh get-serialno | tr -d '\r')"
TREE_LINE="origin/main $(git rev-parse --short=12 HEAD)$(git diff-index --quiet HEAD -- || echo ' (dirty working tree at receipt time)')"
cat > "$OUT/receipt.json" <<EOF
{
  "host": "android",
  "udid": "$UDID",
  "runner": "hosts/android/ci/run-ble.sh",
  "phase": "android.ble-plane ($MODE)",
  "launch": "emulator/device, $EXTRAS (Debug)",
  "tree": "$TREE_LINE",
  "engine": "$(sed -n 's/^PIN=//p' runtime/dsh/vendor/ensure.sh)",
  "scenarios": [
    { "manifest": "$SCEN", "verdict": "verdict-$SCEN.json", "pass": true }$( [ "$MODE" != "device" ] && printf ',\n    { "manifest": "%s-audit", "verdict": "verdict-%s-audit.json", "pass": true }' "$SCEN" "$SCEN" )
  ],
  "producedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
say "receipt written — android.ble-plane green ($MODE, $OUT)"
