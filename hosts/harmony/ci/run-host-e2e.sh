#!/bin/sh
# run-host-e2e.sh — one invocation drives the whole on-emulator host E2E
# (the Android twin is hosts/android/ci/run-spike-e2e.sh; the platform
# toolchain is documented in hosts/harmony/README.md):
#
#   build (unless DSH_SKIP_BUILD=1) -> install -> launch ->
#   UI-automation drive (ci/drive-binding.mjs, the m5 phase) ->
#   official-web drive (ci/drive-official.mjs, the D9 phases) -> captures ->
#   6 checker verdicts (m1.spike.boot, m2.bridge.smoke, m2.session — the
#   23-event regression, m5.host-binding, b-harmony.official-web-mount,
#   b-harmony.httpfetch-v2) + the full deliverable set (logs.txt +
#   scenario.jsonl + receipt-fodder verdicts + real-PNG screenshots) into
#   the artifacts dir.
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
    hosts/harmony/ci/vendor-official.sh
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

# Wake + unlock, then a clean relaunch. The launch itself is retried with a
# wake+unlock before each attempt: a cold-booted emulator can still be on the
# lock screen when aa start runs, and the failure ("device screen is locked")
# is only visible in aa start's output — never treat the launch as fired
# until it reports success (rule 5).
"$HDC" shell power-shell wakeup >/dev/null 2>&1 || true
"$HDC" shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
"$HDC" shell aa force-stop $BUNDLE >/dev/null 2>&1 || true
# A silently-failed force-stop leaves the app resident: the streamed launch
# below only foregrounds the old scene (no onCreate, no scenario) and the
# drive starves its whole deadline. Verify the kill landed (rule 5).
if [ -n "$("$HDC" shell pidof $BUNDLE 2>/dev/null | tr -d '[:space:]')" ]; then
    echo "::error::aa force-stop left $BUNDLE resident (pidof non-empty)" >&2
    exit 1
fi
"$HDC" shell hilog -r >/dev/null

# Launch VERIFIED: `aa start`'s exit code is not evidence — right after a
# fresh `install -r` the BMS is still settling and a start reports success
# without any process appearing (observed on the cold-booted emulator: no
# onCreate, no dsh lines, the drive starves its deadline). The waited-for
# condition is the PID; every retry re-wakes and re-unlocks first (rule 8).
deadline=$(( $(date +%s) + 120 ))
until [ -n "$("$HDC" shell pidof $BUNDLE 2>/dev/null | tr -d '[:space:]')" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "::error::$BUNDLE process never appeared within 120s of aa start"
        exit 1
    fi
    "$HDC" shell power-shell wakeup >/dev/null 2>&1 || true
    "$HDC" shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
    "$HDC" shell aa start -b $BUNDLE -a EntryAbility >/dev/null 2>&1 || true
    sleep 3
done

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

# The m5 verdict chains into the D9 phases on-device; this drive only takes
# the evidence screenshots and waits for the terminal markers.
node hosts/harmony/ci/drive-official.mjs --hdc "$HDC" \
    --overall-deadline 420 \
    --shot-boot "$OUT/b1-official-boot-screen.png" \
    --shot-final "$OUT/b1-final-state.png"

# snapshot_display emits JPEG; evidence screenshots must be real PNGs for
# their .png names — documented one-line conversion (macOS sips), applied
# in place right after the capture (audit gap: JPEG bytes under .png).
for shot in "$OUT/m5-live-deltas.png" "$OUT/m5-binding-complete.png" \
            "$OUT/b1-official-boot-screen.png" "$OUT/b1-final-state.png"; do
    sips -s format png "$shot" --out "$shot" >/dev/null
done

kill "$streamer" 2>/dev/null || true
wait "$streamer" 2>/dev/null || true
trap - EXIT
grep 'dsh.spike' "$STREAM" > "$OUT/logs.txt" || true

"$HDC" file recv "$BASE/dsh-spike-capture.log" "$OUT/sink-capture.txt" >/dev/null
"$HDC" file recv "$BASE/dsh-host-capture.log" "$OUT/binding-capture.txt" >/dev/null
"$HDC" file recv "$BASE/dsh-official-capture.log" "$OUT/official-capture.txt" >/dev/null
"$HDC" file recv "$BASE/dsh-httpfetch-capture.log" "$OUT/httpfetch-capture.txt" >/dev/null

# scenario.jsonl: the canonical dsh.spike.log lines of THIS run, extracted
# from the run's own capture files (trio + binding + official phases, in run
# order) — same extraction convention as hosts/android/ci/run-android-full.sh
# and hosts/harmony/artifacts/m1-spike (grep of a real capture, never
# synthesized).
grep -h '^dsh.spike.log:' "$OUT/sink-capture.txt" "$OUT/binding-capture.txt" \
    "$OUT/official-capture.txt" "$OUT/httpfetch-capture.txt" \
    > "$OUT/scenario.jsonl"

# E2E by logs: one checker verdict per scenario manifest against its capture
# file (regression trio vs the sync-run capture; the binding phase vs its
# own; the D9 phases vs theirs).
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
check tools/e2e/scenarios/b-harmony-official-web-mount.json "$OUT/official-capture.txt"
check tools/e2e/scenarios/b-harmony-httpfetch-v2.json "$OUT/httpfetch-capture.txt"

if [ "$fail" != "0" ]; then
    echo "::error::one or more E2E checkers failed — see $OUT/verdict-*.json"
    exit 1
fi
echo "run-host-e2e: PASS (m1.spike.boot + m2.bridge.smoke + m2.session + m5.host-binding + b-harmony.official-web-mount + b-harmony.httpfetch-v2)"
