#!/bin/sh
# run-upstream-suite.sh (HarmonyOS) — the upstream DSH test suite ON THE
# HARMONY HOST: one transpiled spec per app launch, executed by the
# quickjs-shaped harness in the on-device runtime; per-test verdicts stream
# as dsh.spike records and the summary verdict is read from the PULLED
# capture file (truncation-proof — the same discipline as
# hosts/harmony/ci/run-host-e2e.sh and run-live-llm.sh: hilog is only the
# completion signal, never the evidence).
#
# The corpus + test closure ride the HAP's rawfile via vendor-official.sh
# --closure-only + --suite-extras BEFORE the build (generated per tag,
# untracked; the standard BUNDLE_FILES drift check judges the tracked tree
# only, so it is not part of this job).
#
# CI-ONLY on this repository's practice: the runner needs the DevEco CLT
# (DSH_CLT, the command-line-tools root — no local harmony toolchain exists,
# ARCHITECTURE.md §8; the dsh-mobile local-toolchains note). The build step
# is the reference runners' shape (ohpm install + hvigorw assembleHap).
#
# usage: [DSH_CLT=...] [HDC=...] run-upstream-suite.sh <spec.mjs> [...] | --all [--limit N]
#        (artifacts: hosts/harmony/artifacts/upstream-suite — aggregate.jsonl,
#         per-spec stream-*.txt + capture-*.txt, totals.json)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

BUNDLE=com.dshmobile.spike
OUT=${DSH_SUITE_OUT:-hosts/harmony/artifacts/upstream-suite}
CORPUS="$ROOT/runtime/spike/upstream-tests"
HAP=hosts/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap
BASE=/data/app/el2/100/base/$BUNDLE/haps/entry
CAPTURE_REMOTE=$BASE/cache/dsh-suite-capture.log
LAUNCH_DEADLINE_SECONDS=300

say() { echo "run-upstream-suite(harmony): $*" >&2; }
die() { echo "::error::run-upstream-suite(harmony): $*" >&2; exit 1; }

[ -n "${DSH_CLT:-}" ] || die "DSH_CLT not set — the DevEco CLT root (owns hvigorw, ohpm, hdc)"
HDC=${HDC:-"$DSH_CLT/sdk/default/openharmony/toolchains/hdc"}
[ -x "$HDC" ] || die "hdc not found at $HDC (set HDC=... to override)"

SPECS=""
if [ "${1:-}" = "--all" ]; then
    LIMIT=${2:-1000000}
    [ -f "$CORPUS/manifest.json" ] \
        || die "transpiled corpus missing ($CORPUS/manifest.json) — run test/upstream-suite/transpile.mjs first"
    SPECS=$(node -e "const m = require('$CORPUS/manifest.json'); console.log(m.transpiled.slice(0, $LIMIT).join('\n'));")
else
    SPECS="$*"
fi
[ -n "$SPECS" ] || die "no specs given (pass spec names, or --all)"
mkdir -p "$OUT"

# ---- build the suite HAP (extras into rawfile first) ------------------------
say "staging the suite extras into rawfile"
sh hosts/harmony/ci/vendor-official.sh --closure-only
sh hosts/harmony/ci/vendor-official.sh --suite-extras

say "building the HAP (suite variant)"
(cd hosts/harmony && "$DSH_CLT/bin/ohpm" install --all >/dev/null)
(cd hosts/harmony && "$DSH_CLT/bin/hvigorw" assembleHap --mode module \
    -p product=default -p buildMode=debug --no-daemon > /tmp/dsh-suite-hap.log 2>&1) \
    || { cat /tmp/dsh-suite-hap.log >&2; die "hvigorw build failed — see /tmp/dsh-suite-hap.log"; }
[ -f "$HAP" ] || die "no HAP produced at $HAP"

# ---- device (bounded polls, rule 8; `hdc shell` rc is meaningless, probe
# by OUTPUT — the run-live-llm measured lesson) -------------------------------
deadline=$(( $(date +%s) + 120 ))
until "$HDC" list targets | grep -q 127.0.0.1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "no emulator target within 120s (start dsh_phone first)"
    sleep 2
done

tries=0
until "$HDC" install -r "$HAP" >/dev/null 2>&1; do
    tries=$(( tries + 1 ))
    [ "$tries" -ge 5 ] && die "hdc install kept failing"
    sleep 2
done

# hilog FLOW CONTROL drops the canonical record stream under burst (the
# run-host-e2e lesson: a 2026-09-21 run lost ALL four waited-for lines over a
# 26-minute window). The suite bursts per-test records, so this is not
# optional here: a dropped `suite/summary` line starves the spec's whole
# deadline while the run had in fact completed. Off with a loud warning —
# a device that refuses it still runs, but the starvation it causes looks
# exactly like a host failure.
for knob in pidoff domainoff; do
    out=$("$HDC" shell hilog -Q "$knob" 2>&1 || true)
    case "$out" in
        *successfully*) ;;
        *) echo "::warning::hilog -Q $knob failed ($out) — the record stream may be dropped and a spec may starve its deadline" >&2 ;;
    esac
done

wake_unlock() {
    "$HDC" shell power-shell wakeup >/dev/null 2>&1 || true
    "$HDC" shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
}

# ---- one launch per spec ----------------------------------------------------
: > "$OUT/aggregate.jsonl"
for spec in $SPECS; do
    STREAM="$OUT/stream-$(echo "$spec" | tr '/' '_').txt"
    CAPTURE="$OUT/capture-$(echo "$spec" | tr '/' '_').txt"
    : > "$STREAM"

    # A silently-failed force-stop leaves the app resident: the launch only
    # foregrounds the old scene (no onCreate, no records) and the spec
    # starves its whole deadline (the run-host-e2e lesson, rule 5).
    "$HDC" shell aa force-stop "$BUNDLE" >/dev/null 2>&1 || true
    if [ -n "$("$HDC" shell pidof "$BUNDLE" 2>/dev/null | tr -d '[:space:]')" ]; then
        echo "{\"spec\":\"$spec\",\"status\":\"force-stop-refused\"}" >> "$OUT/aggregate.jsonl"
        say "$spec: force-stop left the app resident — skipping"
        continue
    fi
    "$HDC" shell hilog -r >/dev/null 2>&1 || true

    "$HDC" shell hilog > "$STREAM" 2>/dev/null || true &
    streamer=$!
    cleanup_streamer() { kill "$streamer" 2>/dev/null || true; }
    trap cleanup_streamer EXIT INT TERM

    # Launch VERIFIED by process, not by aa start's exit code: right after a
    # fresh install the BMS is still settling and a start can report success
    # with no process appearing (observed on the cold-booted emulator).
    wake_unlock
    "$HDC" shell aa start -b "$BUNDLE" -a EntryAbility \
        --ps dsh.e2e.leg upstream.suite --ps dsh.e2e.spec "$spec" >/dev/null 2>&1 || true
    launch_deadline=$(( $(date +%s) + 60 ))
    launched=""
    while [ "$(date +%s)" -lt "$launch_deadline" ]; do
        if [ -n "$("$HDC" shell pidof "$BUNDLE" 2>/dev/null | tr -d '[:space:]')" ]; then
            launched=1
            break
        fi
        wake_unlock
        "$HDC" shell aa start -b "$BUNDLE" -a EntryAbility \
            --ps dsh.e2e.leg upstream.suite --ps dsh.e2e.spec "$spec" >/dev/null 2>&1 || true
        sleep 3
    done
    if [ -z "$launched" ]; then
        echo "{\"spec\":\"$spec\",\"status\":\"launch-refused\"}" >> "$OUT/aggregate.jsonl"
        cleanup_streamer
        trap - EXIT
        say "$spec: process never appeared within 60s of aa start"
        continue
    fi

    # Completion signal: the driver's terminal `suite/summary` record in the
    # hilog stream (polled with a deadline, rule 8). The VERDICT comes from
    # the pulled capture below, never from this stream.
    deadline=$(( $(date +%s) + LAUNCH_DEADLINE_SECONDS ))
    status=done
    until grep -q 'suite/summary' "$STREAM" 2>/dev/null; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            status=timeout
            break
        fi
        sleep 1
    done
    sleep 1
    cleanup_streamer
    trap - EXIT

    # Truncation-proof verdict: the capture is truncated per launch (C-side
    # fopen "w"), so THIS spec's pull carries exactly this spec's records.
    "$HDC" file recv "$CAPTURE_REMOTE" "$CAPTURE" >/dev/null 2>&1 || true

    node - "$spec" "$CAPTURE" "$status" >> "$OUT/aggregate.jsonl" <<'EXTRACT'
const fs = require('fs');
const spec = process.argv[2], capturePath = process.argv[3], status = process.argv[4];
let summary = null;
if (fs.existsSync(capturePath)) {
  for (const line of fs.readFileSync(capturePath, 'utf8').split('\n')) {
    if (!line.startsWith('dsh.spike.log:')) continue;
    let record;
    try { record = JSON.parse(line.slice('dsh.spike.log:'.length)); } catch { continue; }
    const e2e = (record.data ?? [])[0];
    if (e2e?.scenario !== 'upstream.suite') continue;
    if (e2e.event === 'suite/summary') summary = e2e;
  }
}
if (summary !== null) {
  console.log(JSON.stringify({ spec, status: summary.failed > 0 ? 'fail' : 'pass',
    passed: summary.passed, failed: summary.failed, skipped: summary.skipped }));
} else {
  console.log(JSON.stringify({ spec, status: status === 'timeout' ? 'timeout' : 'no-summary' }));
}
EXTRACT
    say "$spec: $(tail -1 "$OUT/aggregate.jsonl" | cut -c1-160)"
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
if (totals.errors > 0 || totals.fileFails > 0 || totals.failed > 0) process.exitCode = 1;
TOTALS

say "artifacts: $OUT"
