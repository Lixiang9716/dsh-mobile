#!/bin/sh
# hosts/harmony/ci/run-camera-plane.sh — the capability plane's camera E2E
# leg on a REAL HarmonyOS DEVICE (D-g mode: a one-click script staged for the
# device, honest about what it cannot do). The local emulator image has no
# camera service (the sibling services' posture, measured 2026-09-26), so the
# REAL burst — the OS permission prompt, JPEG frames, the read-through-scope
# readback, the maxBytes drop — can only be certified on a phone. Until a
# device target is attached this script does nothing but say so; it never
# synthesizes evidence, and hosts/harmony/artifacts/camera-plane/ is created
# only by a real green run.
#
# usage: run-camera-plane.sh   (DSH_CLT overrides the toolchain root;
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
OUT=hosts/harmony/artifacts/camera-plane

say() { echo "run-camera-plane: $*"; }

# D-g discipline: no real device, no run, no invented evidence. The emulator
# (127.0.0.1 targets) is refused BY NAME — its camera service is absent and
# the capture ladder would fail honestly but prove nothing about capture.
TARGET=$("$HDC" list targets 2>/dev/null | grep -v '^$' | grep -v '127\.0\.0\.1' | head -1 || true)
if [ -z "$TARGET" ]; then
    say "SKIP: no physical HarmonyOS device attached. The real burst awaits a"
    say "phone (the emulator's camera service is absent); nothing was built,"
    say "run, or written — no evidence is synthesized for an absent device."
    exit 0
fi
say "device target: $TARGET"

mkdir -p "$OUT/screens"

if [ "${DSH_SKIP_BUILD:-0}" != "1" ]; then
    say "building the HAP"
    (cd hosts/harmony && "$CLT/bin/hvigorw" assembleHap --mode module \
        -p product=default -p buildMode=debug --no-daemon > /tmp/dsh-cp-build.log 2>&1) \
        || { echo "::error::hvigorw build failed — see /tmp/dsh-cp-build.log"; exit 1; }
fi
[ -f "$HAP" ] || { echo "::error::$HAP missing — build first" >&2; exit 1; }

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

STREAM=/tmp/dsh-cp-hilog.txt
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
    "$HDC" shell aa start -b $BUNDLE -a EntryAbility --ps dsh.e2e.leg camera.plane >/dev/null 2>&1 || true
    sleep 3
done

# ---- drive: the TWO consent layers -------------------------------------------
# Layer 1 (gateway): the host's custom approval dialog — its button is
# 'Approve' (Index.ets showApproval); the drive-device-plane.mjs precedent
# taps it by layout probe. Layer 2 (OS): the system permission dialog's
# Allow. The scenario's camera-approval / camera-permission markers are the
# hooks; both buttons are probed from the uitest layout (bounded). After
# both grants the scenario finishes alone; the terminal marker is the C
# verdict line.
say "driving: gateway approval (Approve) + OS camera prompt (Allow)"
VERDICT_LINE=""
overall_deadline=$(( $(date +%s) + 600 ))
allow_tapped=0
approve_tapped=0
while [ "$(date +%s)" -lt "$overall_deadline" ]; do
    if [ "$approve_tapped" = "0" ] && grep -q "ui-wait camera-approval" "$STREAM" 2>/dev/null; then
        sleep 1
        "$HDC" shell uitest dumpLayout -p /data/local/tmp/dsh-cp-layout.json >/dev/null 2>&1 || true
        "$HDC" file recv /data/local/tmp/dsh-cp-layout.json /tmp/dsh-cp-layout.json >/dev/null 2>&1 || true
        if [ -s /tmp/dsh-cp-layout.json ]; then
            HIT=$(node -e '
const t = JSON.parse(require("fs").readFileSync("/tmp/dsh-cp-layout.json", "utf8"));
const walk = (n) => {
  if (n === null || typeof n !== "object") return null;
  const a = n.attributes ?? n;
  const text = [(a.text ?? ""), (a["content-desc"] ?? "")].join(" ").trim();
  if (/^(Approve|批准)$/i.test(text)) {
    const m = (a.bounds ?? "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (m) return [Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2)];
  }
  for (const c of n.children ?? []) { const h = walk(c); if (h) return h; }
  return null;
};
const hit = walk(t);
process.exit(hit ? (console.log(hit[0] + " " + hit[1]), 0) : 1);' 2>/dev/null || true)
            if [ -n "$HIT" ]; then
                # HIT is "x y" — two integers from the probe above; uitest takes them as two args
                # shellcheck disable=SC2086 # intentional word split
                "$HDC" shell uitest uiInput click $HIT >/dev/null 2>&1 || true
                approve_tapped=1
                say "tapped Approve at ($HIT)"
            fi
        fi
    fi
    if [ "$allow_tapped" = "0" ] && grep -q "ui-wait camera-permission" "$STREAM" 2>/dev/null; then
        sleep 1
        "$HDC" shell uitest dumpLayout -p /data/local/tmp/dsh-cp-layout.json >/dev/null 2>&1 || true
        "$HDC" file recv /data/local/tmp/dsh-cp-layout.json /tmp/dsh-cp-layout.json >/dev/null 2>&1 || true
        if [ -s /tmp/dsh-cp-layout.json ]; then
            HIT=$(node -e '
const t = JSON.parse(require("fs").readFileSync("/tmp/dsh-cp-layout.json", "utf8"));
const walk = (n) => {
  if (n === null || typeof n !== "object") return null;
  const a = n.attributes ?? n;
  const text = [(a.text ?? ""), (a["content-desc"] ?? "")].join(" ").trim();
  if (/^(Allow|允许)$/i.test(text)) {
    const m = (a.bounds ?? "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (m) return [Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2)];
  }
  for (const c of n.children ?? []) { const h = walk(c); if (h) return h; }
  return null;
};
const hit = walk(t);
process.exit(hit ? (console.log(hit[0] + " " + hit[1]), 0) : 1);' 2>/dev/null || true)
            if [ -n "$HIT" ]; then
                # HIT is "x y" — two integers from the probe above; uitest takes them as two args
                # shellcheck disable=SC2086 # intentional word split
                "$HDC" shell uitest uiInput click $HIT >/dev/null 2>&1 || true
                allow_tapped=1
                say "tapped Allow at ($HIT)"
            fi
        fi
    fi
    VERDICT_LINE=$(grep "dsh.spike.verdict: harmony.camera-plane" "$STREAM" 2>/dev/null | tail -1 || true)
    [ -n "$VERDICT_LINE" ] && break
    sleep 2
done
if [ -z "$VERDICT_LINE" ]; then
    echo "::error::the harmony.camera-plane verdict never appeared" >&2
    tail -40 "$STREAM" >&2 2>/dev/null || true
    exit 1
fi
say "terminal verdict: $VERDICT_LINE"

kill "$streamer" 2>/dev/null || true
wait "$streamer" 2>/dev/null || true
trap - EXIT
grep 'dsh.spike' "$STREAM" > "$OUT/logs.txt" || true

"$HDC" file recv "$BASE/dsh-camera-plane-capture.log" "$OUT/camera-plane-capture.txt" >/dev/null
grep -h '^dsh.spike.log:' "$OUT/camera-plane-capture.txt" > "$OUT/scenario.jsonl" || true

if node test/e2e/check.mjs --manifest test/e2e/scenarios/camera-plane-capture.json \
    --log "$OUT/camera-plane-capture.txt" \
    --out "$OUT/verdict-camera-plane-capture.json"; then
    :
else
    echo "::error::harmony camera-plane checker failed" >&2
    exit 1
fi

TREE_LINE="origin/main $(git rev-parse --short=12 HEAD)$(git diff-index --quiet HEAD -- || echo ' (dirty working tree at receipt time)')"
cat > "$OUT/receipt.json" <<EOF
{
  "host": "harmony",
  "udid": "$TARGET (physical device)",
  "runner": "hosts/harmony/ci/run-camera-plane.sh",
  "phase": "harmony.camera-plane",
  "launch": "physical device, --ps dsh.e2e.leg camera.plane (Debug)",
  "tree": "$TREE_LINE",
  "engine": "$(sed -n 's/^PIN=//p' runtime/dsh/vendor/ensure.sh)",
  "scenarios": [
    { "manifest": "camera-plane-capture", "verdict": "verdict-camera-plane-capture.json", "pass": true }
  ],
  "screens": [],
  "producedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "run-camera-plane: PASS — harmony.camera-plane green ($OUT)"
