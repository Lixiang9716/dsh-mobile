#!/bin/sh
# hosts/harmony/ci/run-mic-plane.sh — the capability plane's microphone E2E
# leg on the HarmonyOS emulator (scenario `harmony.mic-plane`, ONE launch
# via `--ps dsh.e2e.leg mic.plane`). Sibling of run-device-plane.sh's
# machinery: build → install → wake/unlock → verified launch → hilog stream
# capture → drive-mic-plane.mjs (the OS microphone prompt's allow-button
# tap; SOFT — a pre-granted or auto-granted install has no dialog) →
# capture pull → checker. Evidence under hosts/harmony/artifacts/mic-plane/
# (the e2e-matrix deliverables).
#
# The emulator's mic routes to the host input where the SDK image provides
# one; a dead capture service settles `null`/`unavailable` honestly and the
# scenario walks the refusal leg — the per-host manifest pins the shape the
# run actually produced (the pasteboard posture: never fake the service).
#
# usage: run-mic-plane.sh   (DSH_CLT overrides the toolchain root,
#        DSH_SKIP_BUILD=1 skips the hvigor build)
set -eu
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
CLT=${DSH_CLT:-/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools}
HDC="$CLT/sdk/default/openharmony/toolchains/hdc"
[ -x "$HDC" ] || HDC=$(find "$CLT" -name hdc -type f | head -1)
HAP=hosts/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap
BUNDLE=com.dshmobile.spike
BASE=/data/app/el2/100/base/$BUNDLE/haps/entry/cache
OUT=hosts/harmony/artifacts/mic-plane
mkdir -p "$OUT/screens"

if [ "${DSH_SKIP_BUILD:-0}" != "1" ]; then
    echo "run-mic-plane: building the HAP"
    (cd hosts/harmony && "$CLT/bin/hvigorw" assembleHap --mode module \
        -p product=default -p buildMode=debug --no-daemon > /tmp/dsh-mp-build.log 2>&1) \
        || { echo "::error::hvigorw build failed — see /tmp/dsh-mp-build.log"; exit 1; }
fi
[ -f "$HAP" ] || { echo "::error::$HAP missing — build first" >&2; exit 1; }

# Device presence (the emulator is started separately: `Emulator -start dsh_phone`).
deadline=$(( $(date +%s) + 120 ))
until "$HDC" list targets | grep -q 127.0.0.1; do
    [ "$(date +%s)" -ge "$deadline" ] && { echo "::error::no emulator target within 120s" >&2; exit 1; }
    sleep 2
done

"$HDC" install -r "$HAP" >/dev/null 2>&1 || { echo "::error::hdc install failed" >&2; exit 1; }

# Wake + unlock + verified relaunch (run-device-plane.sh's discipline).
"$HDC" shell power-shell wakeup >/dev/null 2>&1 || true
"$HDC" shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
"$HDC" shell aa force-stop $BUNDLE >/dev/null 2>&1 || true
if [ -n "$("$HDC" shell pidof $BUNDLE 2>/dev/null | tr -d '[:space:]')" ]; then
    echo "::error::aa force-stop left $BUNDLE resident" >&2
    exit 1
fi
"$HDC" shell hilog -r >/dev/null
for knob in pidoff domainoff; do
    "$HDC" shell hilog -Q "$knob" >/dev/null 2>&1 \
        || echo "::warning::hilog -Q $knob failed — the record stream may drop" >&2
done

STREAM=/tmp/dsh-mp-hilog.txt
: > "$STREAM"
"$HDC" shell hilog > "$STREAM" 2>/dev/null &
streamer=$!
trap 'kill "$streamer" 2>/dev/null || true' EXIT

# The streamer must be ATTACHED before aa start (the scenario reaches its
# first markers within ~1s): hilog -r cleared the buffer, so any line in the
# stream proves live attachment (rule 8: polled condition).
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
    "$HDC" shell aa start -b $BUNDLE -a EntryAbility --ps dsh.e2e.leg mic.plane >/dev/null 2>&1 || true
    sleep 3
done
echo "run-mic-plane: launched (dsh.e2e.leg mic.plane), driving the mic prompt"

if node hosts/harmony/ci/drive-mic-plane.mjs --hdc "$HDC" \
    --stream "$STREAM" \
    --overall-deadline 240 \
    --shot-final "$OUT/screens/mic-plane-complete.jpeg"; then
    # the emulator snapshot is JPEG; the matrix gate demands PNG magic
    sips -s format png "$OUT/screens/mic-plane-complete.jpeg" \
        --out "$OUT/screens/mic-plane-complete.png" >/dev/null 2>&1 || true
    rm -f "$OUT/screens/mic-plane-complete.jpeg"
    echo "run-mic-plane: drive green"
else
    echo "::error::the mic-plane drive failed" >&2
    exit 1
fi

kill "$streamer" 2>/dev/null || true
wait "$streamer" 2>/dev/null || true
trap - EXIT
grep 'dsh.spike' "$STREAM" > "$OUT/logs.txt" || true

"$HDC" file recv "$BASE/dsh-mic-plane-capture.log" "$OUT/mic-plane-capture.txt" >/dev/null
grep -h '^dsh.spike.log:' "$OUT/mic-plane-capture.txt" > "$OUT/scenario.jsonl" || true

FAIL=0
node test/e2e/check.mjs --manifest test/e2e/scenarios/harmony-mic-plane.json \
    --log "$OUT/mic-plane-capture.txt" \
    --out "$OUT/verdict-harmony-mic-plane.json" || FAIL=1
node test/e2e/check.mjs --manifest test/e2e/scenarios/harmony-mic-plane-audit.json \
    --log "$OUT/mic-plane-capture.txt" \
    --out "$OUT/verdict-harmony-mic-plane-audit.json" || FAIL=1
if [ "$FAIL" != "0" ]; then
    echo "::error::harmony-mic-plane checkers failed" >&2
    exit 1
fi

TREE_LINE="origin/main $(git rev-parse --short=12 HEAD)$(git diff-index --quiet HEAD -- || echo ' (dirty working tree at receipt time)')"
cat > "$OUT/receipt.json" <<EOF
{
  "host": "harmony",
  "udid": "127.0.0.1:5555 (dsh_phone emulator)",
  "runner": "hosts/harmony/ci/run-mic-plane.sh",
  "phase": "harmony.mic-plane",
  "launch": "dsh_phone emulator, --ps dsh.e2e.leg mic.plane (Debug, drive taps the OS mic prompt)",
  "tree": "$TREE_LINE",
  "engine": "$(sed -n 's/^PIN=//p' runtime/spike/vendor/ensure.sh)",
  "scenarios": [
    { "manifest": "harmony-mic-plane", "verdict": "verdict-harmony-mic-plane.json", "pass": true },
    { "manifest": "harmony-mic-plane-audit", "verdict": "verdict-harmony-mic-plane-audit.json", "pass": true }
  ],
  "screens": ["screens/mic-plane-complete.png"],
  "producedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "run-mic-plane: PASS — harmony.mic-plane green ($OUT)"
