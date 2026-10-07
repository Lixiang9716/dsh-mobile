#!/bin/sh
# run-upstream-parity.sh (HarmonyOS) — the EMULATOR LEG of the upstream
# parity differential, the twin of hosts/android/ci/run-upstream-parity.sh:
# the parity leg (`--ps dsh.e2e.leg upstream.parity`) boots the full spine on
# the in-app SCRIPTED mock-llm route (ParityMockRoute), the projected session
# log MUST equal the committed golden (test/e2e/fixtures/
# upstream-parity-reference.jsonl) — the byte-stream the Node reference leg
# (runtime/dsh/ci/run-upstream-parity.sh) produces. The comparator is
# runtime/dsh/ci/parity-compare.mjs; the evidence lands under
# hosts/harmony/artifacts/upstream-parity/ (capture, port.jsonl,
# parity-verdict.txt, receipt).
#
# usage: run-upstream-parity.sh   (env: DSH_CLT overrides the toolchain root,
#        DSH_SKIP_BUILD=1 skips the hvigor build)
set -eu
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"

BUNDLE=com.dshmobile.host
OUT=${DSH_PARITY_OUT:-hosts/harmony/artifacts/upstream-parity}
GOLDEN="$ROOT/test/e2e/fixtures/upstream-parity-reference.jsonl"
HAP=hosts/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap
BASE=/data/app/el2/100/base/$BUNDLE/haps/entry
CAPTURE_REMOTE=$BASE/cache/dsh-parity-capture.log

say() { echo "run-upstream-parity(harmony): $*"; }
die() { echo "::error::run-upstream-parity(harmony): $*" >&2; exit 1; }

[ -f "$GOLDEN" ] || die "golden missing: $GOLDEN"
[ -f "$HAP" ] || die "HAP missing: $HAP (build first, or run with DSH_SKIP_BUILD unset)"

mkdir -p "$OUT"

# ---- the toolchain + device, bounded polls (rule 8) -------------------------
CLT=${DSH_CLT:-/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools}
HDC="$CLT/sdk/default/openharmony/toolchains/hdc"
[ -x "$HDC" ] || HDC=$(find "$CLT" -name hdc -type f | head -1)

deadline=$(( $(date +%s) + 120 ))
until "$HDC" list targets | grep -q 127.0.0.1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "no emulator target within 120s (start dsh_phone first)"
    sleep 3
done

"$HDC" install -r "$HAP" >/dev/null 2>&1 || die "hdc install kept failing"

"$HDC" shell aa force-stop $BUNDLE >/dev/null 2>&1 || true
"$HDC" shell "rm -f $CAPTURE_REMOTE" >/dev/null 2>&1 || true
"$HDC" shell hilog -r >/dev/null 2>&1 || true

# ---- launch + bounded verdict wait (the verdict line is the evidence) ------
"$HDC" shell "aa start -b $BUNDLE -a EntryAbility --ps dsh.e2e.leg upstream.parity" >/dev/null 2>&1 || true
deadline=$(( $(date +%s) + 600 ))
verdict=""
until verdict=$("$HDC" shell "grep -h 'dsh.runtime.verdict: upstream.parity' $CAPTURE_REMOTE 2>/dev/null" | head -1); do
    [ "$(date +%s)" -ge "$deadline" ] && {
        "$HDC" file recv "$CAPTURE_REMOTE" "$OUT/capture.txt" >/dev/null 2>&1 || true
        tail -40 "$OUT/capture.txt" 2>/dev/null >&2 || true
        die "upstream.parity did not reach a verdict within 600s"
    }
    sleep 5
done
echo "$verdict" | tee "$OUT/results.txt"
sleep 1   # let the tail of the projection flush before the pull

# ---- pull + extract the projected records -----------------------------------
# The sink flushes its tail lazily: the verdict line can beat the last
# parity/event records to the pulled copy (measured on the first run).
# Pull again until the records are present — bounded (rule 8).
deadline=$(( $(date +%s) + 60 ))
until "$HDC" file recv "$CAPTURE_REMOTE" "$OUT/capture.txt" >/dev/null 2>&1 \
        && grep -q '"event":"parity/event"' "$OUT/capture.txt"; do
    [ "$(date +%s)" -ge "$deadline" ] && die "the pulled capture never carried parity/event records within 60s"
    sleep 3
done
node - "$OUT" <<'EXTRACT'
const fs = require('fs');
const out = process.argv[2];
const lines = fs.readFileSync(`${out}/capture.txt`, 'utf8').split('\n');
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

node runtime/dsh/ci/parity-compare.mjs "$GOLDEN" "$OUT/port.jsonl" | tee "$OUT/parity-verdict.txt"

# ---- receipt -----------------------------------------------------------------
RECORDS=$(grep -c '"event":"parity/event"' "$OUT/capture.txt" || true)
cat > "$OUT/receipt.json" <<EOF
{
  "host": "harmonyos emulator dsh_phone (Windows host, 127.0.0.1:5559)",
  "engine": "quickjs-ng",
  "leg": "upstream.parity (in-app scripted mock-llm route, ParityMockRoute)",
  "golden": "test/e2e/fixtures/upstream-parity-reference.jsonl",
  "parityEvents": $RECORDS,
  "comparator": "runtime/dsh/ci/parity-compare.mjs"
}
EOF
say "parity differential complete — evidence under $OUT"
