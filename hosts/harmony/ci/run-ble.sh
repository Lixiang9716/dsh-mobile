#!/bin/sh
# hosts/harmony/ci/run-ble.sh — the capability plane's BLE-face E2E leg on
# the HarmonyOS emulator (scenario `harmony.ble.plane`, ONE launch via
# `--ps dsh.e2e.leg ble.plane`): build → install → wake/unlock → verified
# launch → hilog stream capture → checker. Evidence under
# hosts/harmony/artifacts/ble-<mode>/ (the e2e-matrix deliverables).
#
# usage: run-ble.sh [skip|mock|device]   (env: DSH_CLT overrides the
#        toolchain root, DSH_SKIP_BUILD=1 skips the hvigor build)
#   skip   the real radio posture — the emulator image has no Bluetooth
#          radio, the kit answers capability error 801: the honest
#          `unavailable` skip leg.
#   mock   the deterministic mock radio — the full GATT ladder through the
#          REAL dispatch (`--ps dsh.e2e.ble.mock true`).
#   device D-g: a REAL device with a signed HAP and a peer advertising the
#          test GATT db. This machine has no ~/.ohos signing config, so the
#          script demands DSH_SIGNED_HAP and refuses an emulator target —
#          prepared-but-blocked here, never faked.
set -eu
MODE="${1:-skip}"
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
CLT=${DSH_CLT:-/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools}
HDC="$CLT/sdk/default/openharmony/toolchains/hdc"
[ -x "$HDC" ] || HDC=$(find "$CLT" -name hdc -type f | head -1)
HAP=hosts/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap
BUNDLE=com.dshmobile.spike
BASE=/data/app/el2/100/base/$BUNDLE/haps/entry/cache

case "$MODE" in
  skip)   MOCK_PS="";                                                SCEN="harmony-ble" ;;
  mock)   MOCK_PS="--ps dsh.e2e.ble.mock true";                      SCEN="harmony-ble-mock" ;;
  device)
    [ -n "${DSH_SIGNED_HAP:-}" ] || {
      echo "run-ble: FAIL: device mode needs DSH_SIGNED_HAP (a signed HAP) — this" >&2
      echo "  machine has no ~/.ohos signing config; the leg is prepared-but-blocked (D-g)." >&2
      exit 3
    }
    HAP="$DSH_SIGNED_HAP";                                           SCEN="harmony-ble-device" ;;
  *) echo "run-ble: unknown mode $MODE (want skip|mock|device)" >&2; exit 2 ;;
esac
OUT=hosts/harmony/artifacts/ble-$MODE
mkdir -p "$OUT/screens"

if [ "${DSH_SKIP_BUILD:-0}" != "1" ]; then
    echo "run-ble: building the HAP"
    (cd hosts/harmony && "$CLT/bin/hvigorw" assembleHap --mode module \
        -p product=default -p buildMode=debug --no-daemon > /tmp/dsh-ble-build.log 2>&1) \
        || { echo "::error::hvigorw build failed — see /tmp/dsh-ble-build.log"; exit 1; }
fi
[ -f "$HAP" ] || { echo "::error::$HAP missing — build first" >&2; exit 1; }

# Device presence (the emulator is started separately: `Emulator -start dsh_phone`).
deadline=$(( $(date +%s) + 120 ))
until "$HDC" list targets | grep -q 127.0.0.1; do
    [ "$(date +%s)" -ge "$deadline" ] && { echo "::error::no emulator target within 120s" >&2; exit 1; }
    sleep 2
done

"$HDC" install -r "$HAP" >/dev/null 2>&1 || { echo "::error::hdc install failed" >&2; exit 1; }

# Wake + unlock + verified relaunch (run-host-e2e.sh's discipline).
"$HDC" shell power-shell wakeup >/dev/null 2>&1 || true
"$HDC" shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
"$HDC" shell aa force-stop $BUNDLE >/dev/null 2>&1 || true
"$HDC" shell hilog -r >/dev/null

STREAM=/tmp/dsh-ble-hilog.txt
: > "$STREAM"
"$HDC" shell hilog > "$STREAM" 2>/dev/null &
streamer=$!
trap 'kill "$streamer" 2>/dev/null || true' EXIT

attach_deadline=$(( $(date +%s) + 60 ))
until [ -s "$STREAM" ]; do
    [ "$(date +%s)" -ge "$attach_deadline" ] && { echo "::error::hilog streamer never attached" >&2; exit 1; }
    sleep 0.2
done

deadline=$(( $(date +%s) + 120 ))
until [ -n "$("$HDC" shell pidof $BUNDLE 2>/dev/null | tr -d '[:space:]')" ]; do
    [ "$(date +%s)" -ge "$deadline" ] && { echo "::error::$BUNDLE never appeared" >&2; exit 1; }
    "$HDC" shell power-shell wakeup >/dev/null 2>&1 || true
    "$HDC" shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
    # MOCK_PS is an aa flag bundle ("--ps k v") and empty in skip mode — the
    # split (and the vanish) is the contract; quoting would pass an empty arg
    # shellcheck disable=SC2086 # intentional word split
    "$HDC" shell aa start -b "$BUNDLE" -a EntryAbility \
        --ps dsh.e2e.leg ble.plane $MOCK_PS >/dev/null 2>&1 || true
    sleep 3
done

# The scenario completes with no UI driving (no dialogs: the caller
# manifest declares the `ble` grant, and the mock/absent radio needs no
# taps). Poll the capture for the scenario's completion record.
deadline=$(( $(date +%s) + 300 ))
until "$HDC" file recv "$BASE/dsh-ble-capture.log" "$OUT/ble-capture.txt" >/dev/null 2>&1 \
    && grep -q '"event":"scenario.complete"' "$OUT/ble-capture.txt" 2>/dev/null; do
    [ "$(date +%s)" -ge "$deadline" ] && {
        echo "::error::ble.plane did not complete within 300s" >&2
        tail -20 "$OUT/ble-capture.txt" 2>/dev/null || true
        exit 1
    }
    sleep 3
done

kill "$streamer" 2>/dev/null || true
wait "$streamer" 2>/dev/null || true
trap - EXIT
grep 'dsh.spike' "$STREAM" > "$OUT/logs.txt" || true
grep -h '^dsh.spike.log:' "$OUT/ble-capture.txt" > "$OUT/scenario.jsonl" || true

if node test/e2e/check.mjs --manifest test/e2e/scenarios/$SCEN.json \
    --log "$OUT/ble-capture.txt" \
    --out "$OUT/verdict-$SCEN.json"; then
    :
else
    echo "::error::$SCEN checker failed" >&2
    exit 1
fi

TREE_LINE="origin/main $(git rev-parse --short=12 HEAD)$(git diff-index --quiet HEAD -- || echo ' (dirty working tree at receipt time)')"
cat > "$OUT/receipt.json" <<EOF
{
  "host": "harmony",
  "udid": "127.0.0.1:5555 (dsh_phone emulator)",
  "runner": "hosts/harmony/ci/run-ble.sh",
  "phase": "harmony.ble.plane ($MODE)",
  "launch": "dsh_phone emulator, --ps dsh.e2e.leg ble.plane $MOCK_PS (Debug)",
  "tree": "$TREE_LINE",
  "engine": "$(sed -n 's/^PIN=//p' runtime/spike/vendor/ensure.sh)",
  "scenarios": [
    { "manifest": "$SCEN", "verdict": "verdict-$SCEN.json", "pass": true }
  ],
  "producedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "run-ble: receipt written — harmony.ble.plane green ($MODE, $OUT)"
