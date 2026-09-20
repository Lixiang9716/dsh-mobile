#!/bin/sh
# run-host-e2e.sh — one invocation drives the whole on-emulator host E2E
# (the Android twin is hosts/android/ci/run-spike-e2e.sh; the platform
# toolchain is documented in hosts/harmony/README.md):
#
#   build (unless DSH_SKIP_BUILD=1) -> install -> launch ->
#   UI-automation drive (ci/drive-binding.mjs) -> capture -> 4 checker
#   verdicts (m1.spike.boot, m2.bridge.smoke, m2.session — the 23-event
#   regression — and m5.host-binding) + screenshots into the artifacts dir.
#
# Every wait is a polled condition with a deadline (rules.md rule 8); every
# exhaustion is loud (rule 5). E2E by logs: the checkers run against the
# pulled capture FILES (truncation-proof), never against hilog, and each
# manifest's records are filtered by their scenario field.
#
# usage: [DSH_SKIP_BUILD=1] hosts/harmony/ci/run-host-e2e.sh [artifacts-dir]
set -eu

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
CLT=${DSH_CLT:-/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools}
HDC="$CLT/sdk/default/openharmony/toolchains/hdc"
OUT=${1:-hosts/harmony/artifacts/m5-host}
HAP=hosts/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap
BUNDLE=com.dshmobile.spike
BASE=/data/app/el2/100/base/$BUNDLE/haps/entry/cache

if [ "${DSH_SKIP_BUILD:-0}" != "1" ]; then
    (cd hosts/harmony && "$CLT/bin/ohpm" install --all >/dev/null)
    (cd hosts/harmony && "$CLT/bin/hvigorw" assembleHap --mode module \
        -p product=default -p buildMode=debug --no-daemon > /tmp/dsh-harmony-build.log 2>&1) \
        || { echo "::error::hvigorw build failed — see /tmp/dsh-harmony-build.log"; exit 1; }
fi
if [ ! -f "$HAP" ]; then
    echo "::error::$HAP missing — build first or unset DSH_SKIP_BUILD"
    exit 1
fi

# Device presence, bounded poll (rule 8): the emulator is started separately
# (`$CLT/emulator/Emulator -start dsh_phone`).
deadline=$(( $(date +%s) + 120 ))
until "$HDC" list targets | grep -q 127.0.0.1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "::error::no emulator target within 120s (start dsh_phone first)"
        exit 1
    fi
    sleep 2
done

tries=0
until "$HDC" install -r "$HAP" >/dev/null 2>&1; do
    tries=$(( tries + 1 ))
    if [ "$tries" -ge 5 ]; then
        echo "::error::hdc install kept failing"
        exit 1
    fi
    sleep 2
done

# Wake + unlock, then a clean relaunch.
"$HDC" shell power-shell wakeup >/dev/null 2>&1 || true
"$HDC" shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
"$HDC" shell aa force-stop $BUNDLE >/dev/null 2>&1 || true
"$HDC" shell hilog -r >/dev/null

mkdir -p "$OUT"
STREAM=/tmp/dsh-harmony-hilog.txt
: > "$STREAM"
"$HDC" shell hilog > "$STREAM" 2>/dev/null &
streamer=$!
trap 'kill "$streamer" 2>/dev/null || true' EXIT

"$HDC" shell aa start -b $BUNDLE -a EntryAbility >/dev/null

node hosts/harmony/ci/drive-binding.mjs --hdc "$HDC" \
    --overall-deadline 300 \
    --shot-live "$OUT/m5-live-deltas.png" \
    --shot-final "$OUT/m5-binding-complete.png"

kill "$streamer" 2>/dev/null || true
wait "$streamer" 2>/dev/null || true
trap - EXIT
grep 'dsh.spike' "$STREAM" > "$OUT/logs.txt" || true

"$HDC" file recv "$BASE/dsh-spike-capture.log" "$OUT/sink-capture.txt" >/dev/null
"$HDC" file recv "$BASE/dsh-host-capture.log" "$OUT/binding-capture.txt" >/dev/null

# E2E by logs: one checker verdict per scenario manifest against its capture
# file (regression trio vs the sync-run capture; the binding phase vs its own).
fail=0
check() {
    manifest=$1
    log=$2
    name=$(basename "$manifest" .json)
    if node tools/e2e/check.mjs --manifest "$manifest" --log "$log" \
        --out "$OUT/verdict-$name.json"; then
        :
    else
        fail=1
    fi
}
check tools/e2e/scenarios/m1-spike-boot.json "$OUT/sink-capture.txt"
check tools/e2e/scenarios/m2-bridge-smoke.json "$OUT/sink-capture.txt"
check tools/e2e/scenarios/m2-session.json "$OUT/sink-capture.txt"
check tools/e2e/scenarios/m5-host-binding.json "$OUT/binding-capture.txt"

if [ "$fail" != "0" ]; then
    echo "::error::one or more E2E checkers failed — see $OUT/verdict-*.json"
    exit 1
fi
echo "run-host-e2e: PASS (m1.spike.boot + m2.bridge.smoke + m2.session + m5.host-binding)"
