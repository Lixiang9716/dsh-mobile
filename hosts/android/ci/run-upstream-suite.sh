#!/bin/sh
# run-upstream-suite.sh — the UPSTREAM DSH TEST SUITE ON THE ANDROID
# EMULATOR (the owner's target): one transpiled upstream spec per app
# launch, executed by the quickjs-shaped harness inside our runtime; every
# per-test verdict streams as a scenario record and lands in the aggregate
# evidence. The corpus is staged under filesDir/spike/upstream-tests/
# (copyAssetDir MERGES on launch, so staged specs survive relaunches).
#
# usage: run-upstream-suite.sh <spec.mjs> [spec.mjs ...] | --all [--limit N]
#        (artifacts: hosts/android/artifacts/upstream-suite)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

PKG=com.dshmobile.spike
APK=hosts/android/app/build/outputs/apk/debug/app-debug.apk
CORPUS="$ROOT/runtime/spike/upstream-tests"
OUT=${DSH_SUITE_OUT:-hosts/android/artifacts/upstream-suite}
LAUNCH_DEADLINE_SECONDS=300

say() { echo "run-upstream-suite: $*" >&2; }
die() { echo "::error::run-upstream-suite: $*" >&2; exit 1; }

[ -f "$APK" ] || die "apk missing: $APK (build first: hosts/android/gradlew assembleDebug)"

SPECS=""
if [ "${1:-}" = "--all" ]; then
    LIMIT=${2:-1000000}
    SPECS=$(node -e "
const m = require('$CORPUS/manifest.json');
console.log(m.transpiled.slice(0, $LIMIT).join('\n'));")
else
    SPECS="$*"
fi
[ -n "$SPECS" ] || die "no specs given (pass spec names, or --all)"
mkdir -p "$OUT"

# ---- device + boot, one bounded poll (the run-spike-e2e discipline) --------
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

# Stage the whole corpus ONCE (per-file run-as cp would be 667 round trips;
# one tar through /data/local/tmp is a single push + extract). The corpus
# dir is WIPED first: a regenerated corpus (fewer transpiled specs after a
# transpiler change) must not leave stale specs behind — stale files would
# run under a name no manifest counts.
say "staging the corpus"
CORPUS_TGZ="$(mktemp /tmp/dsh-suite-corpus.XXXXXX.tgz)"
tar czf "$CORPUS_TGZ" -C "$CORPUS" .
adb push "$CORPUS_TGZ" /data/local/tmp/dsh-suite-corpus.tgz >/dev/null
adb shell "run-as $PKG sh -c 'rm -rf files/spike/upstream-tests && mkdir -p files/spike/upstream-tests && tar xzf /data/local/tmp/dsh-suite-corpus.tgz -C files/spike/upstream-tests'"
rm -f "$CORPUS_TGZ"
adb shell "run-as $PKG ls files/spike/upstream-tests | wc -l" | tr -d '\r' | \
    { read -r staged; say "staged $staged corpus files"; }

# The suite driver + harness ship as TRACKED APK assets (staged by
# stage-spine-closure.sh from runtime/spike/scenario — the single source).
# copyAssetDir re-merges assets over filesDir on every launch, so a
# runner-pushed copy would be clobbered on first boot anyway; the APK is the
# only source that sticks.
say "corpus staged (driver + harness come from the APK assets)"

# ---- one launch per spec ---------------------------------------------------
: > "$OUT/aggregate.jsonl"
PASS_TOTAL=0; FAIL_TOTAL=0; FILES_PASS=0; FILES_FAIL=0; FILES_ERROR=0
for spec in $SPECS; do
    STREAM="$OUT/stream-$(echo "$spec" | tr '/' '_').txt"
    adb logcat -c
    adb shell am force-stop $PKG >/dev/null 2>&1 || true
    : > "$STREAM"
    adb logcat -s dsh.spike dsh.spike.result > "$STREAM" 2>/dev/null &
    streamer=$!
    cleanup_streamer() { kill "$streamer" 2>/dev/null || true; }
    trap cleanup_streamer EXIT INT TERM

    adb shell am start -n $PKG/.MainActivity --ez dsh.suite true --es dsh.spec "$spec" >/dev/null 2>&1 \
        || { cleanup_streamer; die "am start failed for $spec"; }

    deadline=$(( $(date +%s) + LAUNCH_DEADLINE_SECONDS ))
    timed_out=0
    until grep -q "dsh.spike.result: ALL" "$STREAM" 2>/dev/null; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "{\"spec\":\"$spec\",\"status\":\"timeout\"}" >> "$OUT/aggregate.jsonl"
            FILES_ERROR=$((FILES_ERROR + 1))
            timed_out=1
            cleanup_streamer
            break
        fi
        sleep 0.2
    done
    sleep 0.3
    cleanup_streamer
    trap - EXIT
    # A timed-out spec already has its aggregate line; extracting a summary
    # from the truncated stream would DOUBLE-COUNT the file in totals.json.
    if [ "$timed_out" = "1" ]; then
        say "$spec: timeout (no summary in ${LAUNCH_DEADLINE_SECONDS}s)"
        continue
    fi

    sed '/dsh.spike.result: ALL/q' "$STREAM" > "$STREAM.final" 2>/dev/null || cp "$STREAM" "$STREAM.final"
    # the aggregate line: one JSON per spec from its suite/summary record
    node - "$spec" "$STREAM.final" >> "$OUT/aggregate.jsonl" <<'EXTRACT'
const fs = require('fs');
const spec = process.argv[2], logPath = process.argv[3];
let summary = null, failed = 0;
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  const at = line.indexOf('{');
  if (at < 0) continue;
  let record;
  try { record = JSON.parse(line.slice(at)); } catch { continue; }
  const e2e = (record.data ?? [])[0];
  if (e2e?.scenario !== 'upstream.suite') continue;
  if (e2e.event === 'test/fail') failed += 1;
  if (e2e.event === 'suite/summary') summary = e2e;
}
if (summary === null) {
  console.log(JSON.stringify({ spec, status: 'no-summary', testFailures: failed }));
} else {
  console.log(JSON.stringify({ spec, status: summary.failed > 0 ? 'fail' : 'pass',
    passed: summary.passed, failed: summary.failed, skipped: summary.skipped }));
}
EXTRACT
    # count the spec verdict for the runner's own summary
    verdict=$(tail -1 "$OUT/aggregate.jsonl")
    case "$verdict" in
        *'"status":"pass"'*) FILES_PASS=$((FILES_PASS + 1)) ;;
        *'"status":"fail"'*) FILES_FAIL=$((FILES_FAIL + 1)) ;;
        *) FILES_ERROR=$((FILES_ERROR + 1)) ;;
    esac
    say "$spec: $(echo "$verdict" | cut -c1-160)"
done

node - "$OUT" <<'TOTALS'
const fs = require('fs');
const lines = fs.readFileSync(`${process.argv[2]}/aggregate.jsonl`, 'utf8').trim().split('\n').filter(Boolean)
  .map((l) => JSON.parse(l));
const totals = lines.reduce((acc, r) => ({
  files: acc.files + 1,
  passed: acc.passed + (r.passed ?? 0),
  failed: acc.failed + (r.failed ?? 0),
  skipped: acc.skipped + (r.skipped ?? 0),
  errors: acc.errors + (r.status !== 'pass' && r.status !== 'fail' ? 1 : 0),
  fileFails: acc.fileFails + (r.status === 'fail' ? 1 : 0),
}), { files: 0, passed: 0, failed: 0, skipped: 0, errors: 0, fileFails: 0 });
fs.writeFileSync(`${process.argv[2]}/totals.json`, JSON.stringify(totals, null, 2));
console.log(JSON.stringify(totals));
TOTALS

say "artifacts: $OUT (aggregate.jsonl, totals.json, per-spec streams)"
