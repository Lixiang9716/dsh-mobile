#!/bin/sh
# runtime/dsh/ci/run-security-gateway-fuzz.sh — the CLI proof run for the
# adversarial leg `security.gateway-fuzz` (docs/security-threat-model.md,
# surface "gateway validation"): a 21-case malformed-primitive battery fired
# through the RAW __dshGatewayCall seam — wrong types, missing fields, scope
# escapes, overlong values, negative/missing bounds, unknown primitive names,
# malformed args JSON, and two out-of-scope socket targets (a lan listen and
# a 169.254.169.254 metadata-service dial).
#
# Three gates, layered like run-socket-seam.sh:
#   1. the JS gate — every case is one structured record, matched one-to-one
#      by test/e2e/scenarios/security-gateway-fuzz.json; a case that RESOLVES
#      (the attack landed) fails the scenario itself;
#   2. the AUDIT gate — the two socket attacks must leave denied-attempt
#      audit records on the host's stderr with the FIXED reason codes
#      (contract §6: refusals are the interesting half; attacker-controlled
#      text never enters the audit JSON);
#   3. the SURVIVAL gate — the scenario's own benign post-battery roundtrip
#      (fuzz.survived) proves the process is alive and the gateway still
#      serves honest callers.
#
# usage: run-security-gateway-fuzz.sh [--art-dir DIR] [--skip-build]
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

ART=artifacts/macos-cli-security-gateway-fuzz
SKIP_BUILD=0
while [ $# -gt 0 ]; do
    case "$1" in
        --art-dir) ART="$2"; shift 2 ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        *) echo "run-security-gateway-fuzz: unknown argument '$1'" >&2; exit 2 ;;
    esac
done
case "$ART" in
    /tmp/*) echo "run-security-gateway-fuzz: --art-dir must not be under /tmp (evidence lives with the repo)" >&2; exit 2 ;;
esac
case "$ART" in /*) ;; *) ART="$PWD/$ART" ;; esac

mkdir -p "$ART"

echo "== 1/2 build =="
if [ "$SKIP_BUILD" -eq 0 ]; then
    sh host/build.sh >/dev/null
fi

echo "== 2/2 JS gate: the malformed-primitive battery =="
LOG="$ART/logs.txt"
rm -f "$LOG"
# --http: the httpFetch validation face (missing url) is served, not the
# declared-unavailable fallback — the battery attacks the validator.
RC=0
(cd . && ./build/dsh-spike-cli . scenario/security-gateway-fuzz.js --http > "$LOG" 2>&1) || RC=$?
grep '^dsh.spike.log:' "$LOG" > "$ART/scenario.jsonl" || true
grep '^{"audit":"socket\.' "$LOG" > "$ART/gateway-audit.jsonl" || true
# The checker is the authoritative gate; the exit code is reported beside it
# (a non-zero exit is a crashed process OR a failed scenario — the log and
# the verdict say which; both fail this script).
node "$ROOT/test/e2e/check.mjs" --manifest "$ROOT/test/e2e/scenarios/security-gateway-fuzz.json" \
    --log "$LOG" --out "$ART/verdict.json"
if [ "$RC" -ne 0 ]; then
    echo "   FAIL: the host exited $RC (crash, or the scenario reported failure — see $LOG)" >&2
    exit 1
fi

echo "== audit gate: both socket attacks denied on the record =="
# Fixed reason codes: scope-not-loopback / host-not-loopback. One record per
# denied attempt, no attacker-controlled text inside.
N_DENIED=$(grep -c '"outcome":"denied"' "$ART/gateway-audit.jsonl" || true)
[ "$N_DENIED" -eq 2 ] || { echo "   FAIL: expected 2 denied audits, got $N_DENIED" >&2; exit 1; }
grep -q '"reason":"scope-not-loopback"' "$ART/gateway-audit.jsonl" \
    || { echo "   FAIL: the lan-listen attempt left no audit record" >&2; exit 1; }
grep -q '"reason":"host-not-loopback"' "$ART/gateway-audit.jsonl" \
    || { echo "   FAIL: the metadata-dial attempt left no audit record" >&2; exit 1; }
echo "   audits: denied=$N_DENIED (fixed reason codes, no raw request values)"

cat > "$ART/receipt.json" <<EOF
{
 "host": "macOS $(uname -m) (the desktop CLI, no simulator)",
 "phase": "security adversarial leg 1/4 — the gateway validation face under a malformed-primitive battery (docs/security-threat-model.md)",
 "launchConfiguration": "./build/dsh-spike-cli . scenario/security-gateway-fuzz.js --http",
 "scenarios": [
  {
   "id": "security.gateway-fuzz",
   "checker": "test/e2e/scenarios/security-gateway-fuzz.json",
   "result": "pass",
   "note": "21/21 one-to-one: wrong types, missing fields, ../ and absolute escapes, unknown scopes (denied), a 1MB path, an over-128-char keychain ref, negative/missing timer bounds, three must-not-exist primitive names, two malformed args-JSON bodies, and the two socket-boundary attacks — every one a structured contract-§3 rejection; the benign post-battery roundtrip proves the process survived"
  }
 ],
 "audit": "counts quoted FROM THIS RUN's gate above, generated not hardcoded: denied=$N_DENIED — one record per denied socket attempt, fixed reason codes (artifacts/macos-cli-security-gateway-fuzz/gateway-audit.jsonl)",
 "notes": "A case that resolves instead of rejecting fails the scenario itself (the high-severity path); the survival face is fuzz.survived + a zero exit code, asserted by this script."
}
EOF

echo "run-security-gateway-fuzz: PASS — evidence in $ART"
