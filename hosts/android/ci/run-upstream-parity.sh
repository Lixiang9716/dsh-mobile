#!/bin/sh
# run-upstream-parity.sh (Android) — the EMULATOR LEG of the upstream parity
# differential: the vendored upstream spine drives the same scripted turns
# (success → todo_write tool round → closing success → 401) inside quickjs on
# the on-device host, against the carrier's scripted mock route (MockLlmRoute
# armed with the parity script), and the projected session log MUST equal the
# committed golden (test/e2e/fixtures/upstream-parity-reference.jsonl) — the
# byte-stream the Node reference leg (runtime/spike/ci/run-upstream-parity.sh
# --reference-only) produced from the SAME vendored packages under plain Node.
#
# Every wait is a polled condition with a deadline (rule 8); the capture is
# the logcat stream truncated at the first completion tag (the discipline
# run-spike-e2e.sh learned the hard way).
#
# usage: run-upstream-parity.sh   (artifacts: hosts/android/artifacts/upstream-parity)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

PKG=com.dshmobile.spike
APK=hosts/android/app/build/outputs/apk/debug/app-debug.apk
OUT=${DSH_PARITY_OUT:-hosts/android/artifacts/upstream-parity}
GOLDEN="$ROOT/test/e2e/fixtures/upstream-parity-reference.jsonl"
STREAM="$OUT/stream.txt"

say() { echo "run-upstream-parity: $*"; }
die() { echo "::error::run-upstream-parity: $*" >&2; exit 1; }

[ -f "$GOLDEN" ] || die "golden missing: $GOLDEN"
[ -f "$APK" ] || die "apk missing: $APK (build first: hosts/android/gradlew assembleDebug)"

mkdir -p "$OUT"

# ---- device + boot, one bounded poll (as run-spike-e2e.sh) -----------------
if [ "$(uname)" = "Linux" ] && [ ! -w /dev/kvm ]; then
    die "/dev/kvm missing or not writable — KVM acceleration unavailable"
fi
deadline=$(( $(date +%s) + 600 ))
until adb get-state >/dev/null 2>&1 &&
      [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    if ! pgrep -f "emulator" >/dev/null 2>&1; then
        die "emulator process is gone — boot never started or died"
    fi
    [ "$(date +%s)" -ge "$deadline" ] && die "emulator did not finish booting within 600s"
    sleep 5
done

tries=0
until adb install -r "$APK"; do
    tries=$(( tries + 1 ))
    [ "$tries" -ge 5 ] && die "adb install kept failing after boot"
    sleep 3
done

adb logcat -c
adb shell am force-stop $PKG >/dev/null 2>&1 || true
: > "$STREAM"
# The logcat clear races a reader's initial snapshot: lines buffered BEFORE
# the clear (the previous step's scenarios leave `dsh.spike.result: ALL`
# tags behind) can still reach this stream and instantly satisfy the
# completion wait, truncating the capture before this run logged anything
# ("no parity/event records", seen 2026-09-24). Pin the capture point: a
# canary line this streamer can only see once attached, then judge and
# truncate from the canary onward.
CANARY="parity-begin-$$"
adb logcat -s dsh.spike dsh.spike.result dsh.canary > "$STREAM" 2>/dev/null &
streamer=$!
cleanup() {
    kill "$streamer" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
adb shell log -t dsh.canary "$CANARY" >/dev/null
deadline=$(( $(date +%s) + 60 ))
until grep -q "$CANARY" "$STREAM"; do
    [ "$(date +%s)" -ge "$deadline" ] && die "logcat streamer never attached (canary unseen within 60s)"
    sleep 0.2
done

deadline=$(( $(date +%s) + 60 ))
until adb shell am start -n $PKG/.MainActivity --ez dsh.parity true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "am start kept failing within 60s"
    sleep 2
done

# Both conditions: the scenario's own evidence (stale completion tags cannot
# fake it) and the completion tag itself.
deadline=$(( $(date +%s) + 300 ))
until grep -q "upstream.parity" "$STREAM" && grep -q "dsh.spike.result: ALL" "$STREAM"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "::error::upstream.parity scenario did not complete within 300s" >&2
        tail -80 "$STREAM" >&2
        exit 1
    fi
    sleep 0.2
done
sleep 0.3          # let the completion-tag line itself flush
trap - EXIT
cleanup

awk '/parity-begin-/{seen=1} seen' "$STREAM" | sed '/dsh.spike.result: ALL/q' > "$OUT/logs.txt"
grep 'dsh.spike.log:' "$OUT/logs.txt" > "$OUT/scenario.jsonl" || true

# ---- extract the projected records and diff against the golden -------------
node - "$OUT" <<'EXTRACT'
const fs = require('fs');
const out = process.argv[2];
const lines = fs.readFileSync(`${out}/scenario.jsonl`, 'utf8').split('\n');
const records = [];
for (const line of lines) {
  const at = line.indexOf('{');
  if (at < 0) continue;
  let record;
  try { record = JSON.parse(line.slice(at)); } catch { continue; }
  const e2e = (record.data ?? [])[0];
  if (e2e?.scenario === 'upstream.parity' && e2e.event === 'parity/event' && e2e.record !== undefined) {
    records.push(e2e.record);
  }
}
fs.writeFileSync(`${out}/port.jsonl`, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
if (records.length === 0) { console.error('no parity/event records in the captured stream'); process.exit(1); }
EXTRACT

node runtime/spike/ci/parity-compare.mjs "$GOLDEN" "$OUT/port.jsonl" | tee "$OUT/parity-verdict.txt"

# ---- receipt -----------------------------------------------------------------
EVENTS="$(grep -c '"scenario":"upstream.parity"' "$OUT/logs.txt" || true)"
cat > "$OUT/receipt.json" <<EOF
{
  "host": "android-emulator ($(adb shell getprop ro.build.version.release 2>/dev/null | tr -d '\r'))",
  "engine": "quickjs-ng (the on-device C host)",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim; the SAME closure the Node reference ran)",
  "scenario": "upstream.parity",
  "proves": [
    "the vendored upstream spine produces the SAME projected session log on the Android emulator as under plain Node: the carrier's scripted mock route (MockLlmRoute, parity script) replayed the same wire, the real ToolRuntime dispatched the todo_write round, and the comparator demanded record-for-record identity against the committed golden"
  ],
  "checker": "runtime/spike/ci/parity-compare.mjs vs test/e2e/fixtures/upstream-parity-reference.jsonl",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

say "artifacts: $OUT"
grep 'dsh.spike.result' "$OUT/logs.txt" || true
