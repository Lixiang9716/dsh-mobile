#!/bin/sh
# run-upstream-suite.sh (HarmonyOS) — the upstream DSH test suite ON THE
# HARMONY HOST: one transpiled spec per app launch, executed by the
# quickjs-shaped harness in the on-device runtime; per-test verdicts stream
# as dsh.spike records into hilog and land in the aggregate evidence.
#
# The corpus + test closure ride the HAP's rawfile via vendor-official.sh
# --suite-extras BEFORE the build (generated per tag, untracked; the
# standard BUNDLE_FILES drift check is not part of this job).
#
# CI-ONLY on this repository's practice: the runner needs the DevEco CLT
# (DSH_CLT) — there is no local harmony toolchain (ARCHITECTURE.md §8; the
# dsh-mobile local-toolchains note).
#
# usage: run-upstream-suite.sh <spec.mjs> [...] | --all [--limit N]
#        (artifacts: hosts/harmony/artifacts/upstream-suite)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

BUNDLE=com.dshmobile.spike
OUT=${DSH_SUITE_OUT:-hosts/harmony/artifacts/upstream-suite}
CORPUS="$ROOT/runtime/spike/upstream-tests"
LAUNCH_DEADLINE_SECONDS=300

say() { echo "run-upstream-suite(harmony): $*" >&2; }
die() { echo "::error::run-upstream-suite(harmony): $*" >&2; exit 1; }

HDC=${HDC:-hdc}
command -v "$HDC" >/dev/null 2>&1 || die "hdc not found (set HDC=...)"
[ -n "${DSH_CLT:-}" ] || die "DSH_CLT not set — the DevEco CLT owns the HAP build"

SPECS=""
if [ "${1:-}" = "--all" ]; then
    LIMIT=${2:-1000000}
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

say "building the HAP (harness variant)"
HAP=$(bash "$DSH_CLT" hosts/harmony 2>&1 | tee /tmp/dsh-suite-hap.log | grep -oE '[^ ]+\.hap' | head -1)
[ -n "$HAP" ] || { cat /tmp/dsh-suite-hap.log >&2; die "no HAP produced"; }
say "HAP: $HAP"

# ---- device -----------------------------------------------------------------
"$HDC" shell true >/dev/null 2>&1 || die "no harmony device via hdc"

"$HDC" install -r "$HAP" >/dev/null 2>&1 || die "hdc install failed"

# hilog flow control OFF (the run-host-e2e lesson: burst drops records)
"$HDC" shell hilog -r >/dev/null 2>&1 || true

# ---- one launch per spec ----------------------------------------------------
: > "$OUT/aggregate.jsonl"
for spec in $SPECS; do
    STREAM="$OUT/stream-$(echo "$spec" | tr '/' '_').txt"
    : > "$STREAM"
    "$HDC" shell aa force-stop "$BUNDLE" >/dev/null 2>&1 || true
    "$HDC" shell hilog -r >/dev/null 2>&1 || true
    "$HDC" shell hilog > "$STREAM" 2>/dev/null || true &
    streamer=$!
    cleanup_streamer() { kill "$streamer" 2>/dev/null || true; }
    trap cleanup_streamer EXIT INT TERM

    "$HDC" shell aa start -b "$BUNDLE" -a EntryAbility \
        --ps dsh.e2e.leg upstream.suite --ps dsh.e2e.spec "$spec" >/dev/null 2>&1 \
        || { cleanup_streamer; die "aa start failed for $spec"; }

    deadline=$(( $(date +%s) + LAUNCH_DEADLINE_SECONDS ))
    until grep -q "dsh.spike: ALL" "$STREAM" 2>/dev/null; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "{\"spec\":\"$spec\",\"status\":\"timeout\"}" >> "$OUT/aggregate.jsonl"
            cleanup_streamer
            break
        fi
        sleep 1
    done
    sleep 1
    cleanup_streamer
    trap - EXIT

    node - "$spec" "$STREAM" >> "$OUT/aggregate.jsonl" <<'EXTRACT'
const fs = require('fs');
const spec = process.argv[2], logPath = process.argv[3];
let summary = null;
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  const at = line.indexOf('{');
  if (at < 0 || !line.includes('dsh.spike')) continue;
  let record;
  try { record = JSON.parse(line.slice(at)); } catch { continue; }
  const e2e = (record.data ?? [])[0];
  if (e2e?.scenario !== 'upstream.suite') continue;
  if (e2e.event === 'suite/summary') summary = e2e;
}
if (summary === null) {
  console.log(JSON.stringify({ spec, status: 'no-summary' }));
} else {
  console.log(JSON.stringify({ spec, status: summary.failed > 0 ? 'fail' : 'pass',
    passed: summary.passed, failed: summary.failed, skipped: summary.skipped }));
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
TOTALS

say "artifacts: $OUT"
