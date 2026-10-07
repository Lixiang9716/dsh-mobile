#!/bin/sh
# runtime/dsh/ci/run-security-jail.sh — the CLI proof run for the
# adversarial leg `security.jail` (docs/security-threat-model.md, surfaces
# "QuickJS sandbox / wasm jail" and "the socket seam's loopback boundary"):
#
#   1. the WASM jail — crafted modules run IN-PROCESS by the vendored wasm3
#      (the code path the iOS app ships): a hostile import called (env.evil —
#      the host never links it), the sanctioned name with the wrong signature,
#      an out-of-bounds emit pointer, infinite recursion into the fixed
#      interpreter stack, a missing export, an absent module, a scope-escape
#      path, and a scope the host never granted — every one a structured
#      rejection. The honest echo module runs BEFORE and AFTER the battery
#      (jail.control / jail.survived): the sanctioned surface works and the
#      process survived the whole battery.
#   2. the SOCKET boundary — raw dials to ::1, 0.0.0.0, the NAME localhost,
#      and 127.0.0.2 (loopback-adjacent but not the literal), a mesh-scope
#      listen, and a listen with no scope: every one `denied`, each leaving
#      one audit record with a fixed reason code on the host's stderr.
#
# Gates: the one-to-one JS verdict (security-jail.json) + the audit grep +
# the scenario's own survival rung, like run-socket-seam.sh.
#
# usage: run-security-jail.sh [--art-dir DIR] [--skip-build]
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

ART=artifacts/macos-cli-security-jail
SKIP_BUILD=0
while [ $# -gt 0 ]; do
    case "$1" in
        --art-dir) ART="$2"; shift 2 ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        *) echo "run-security-jail: unknown argument '$1'" >&2; exit 2 ;;
    esac
done
case "$ART" in
    /tmp/*) echo "run-security-jail: --art-dir must not be under /tmp (evidence lives with the repo)" >&2; exit 2 ;;
esac
case "$ART" in /*) ;; *) ART="$PWD/$ART" ;; esac

mkdir -p "$ART"

echo "== 1/2 build =="
if [ "$SKIP_BUILD" -eq 0 ]; then
    sh host/build.sh >/dev/null
fi

echo "== 2/2 JS gate: the jail battery =="
LOG="$ART/logs.txt"
rm -f "$LOG"
RC=0
(cd . && ./build/dsh-spike-cli . scenario/security-jail.js > "$LOG" 2>&1) || RC=$?
grep '^dsh.spike.log:' "$LOG" > "$ART/scenario.jsonl" || true
grep '^{"audit":"socket\.' "$LOG" > "$ART/socket-audit.jsonl" || true
node "$ROOT/test/e2e/check.mjs" --manifest "$ROOT/test/e2e/scenarios/security-jail.json" \
    --log "$LOG" --out "$ART/verdict.json"
if [ "$RC" -ne 0 ]; then
    echo "   FAIL: the host exited $RC (crash, or the scenario reported failure — see $LOG)" >&2
    exit 1
fi

echo "== audit gate: every boundary attack denied on the record =="
N_HOST=$(grep -c '"reason":"host-not-loopback"' "$ART/socket-audit.jsonl" || true)
N_SCOPE=$(grep -c '"reason":"scope-not-loopback"' "$ART/socket-audit.jsonl" || true)
[ "$N_HOST" -eq 4 ] || { echo "   FAIL: expected 4 host-not-loopback audits, got $N_HOST" >&2; exit 1; }
[ "$N_SCOPE" -eq 2 ] || { echo "   FAIL: expected 2 scope-not-loopback audits, got $N_SCOPE" >&2; exit 1; }
echo "   audits: host-not-loopback=$N_HOST scope-not-loopback=$N_SCOPE (fixed reason codes)"

cat > "$ART/receipt.json" <<EOF
{
 "host": "macOS $(uname -m) (the desktop CLI, no simulator)",
 "phase": "security adversarial leg 3/4 — the wasm jail's import surface + the socket loopback boundary (docs/security-threat-model.md); the CLI now SERVES contract v1.2.0 wasmRun through the portable spine (dsh_wasm.c + wasm3, the iOS code path)",
 "launchConfiguration": "./build/dsh-spike-cli . scenario/security-jail.js",
 "scenarios": [
  {
   "id": "security.jail",
   "checker": "test/e2e/scenarios/security-jail.json",
   "result": "pass",
   "note": "8/8 wasm attacks + 6/6 socket attacks rejected with structured codes; the honest echo module (dsh.emit, result 15) runs before AND after the battery — the jail serves sanctioned callers and survives the whole battery"
  }
 ],
 "audit": "counts quoted FROM THIS RUN's gate above, generated not hardcoded: host-not-loopback=$N_HOST scope-not-loopback=$N_SCOPE — one record per denied attempt, fixed reason codes (artifacts/macos-cli-security-jail/socket-audit.jsonl)",
 "notes": "The import surface a wasm module can reach is exactly {dsh.emit(ptr,len)}: an unlinked import traps when called, a wrong-signature dsh.emit refuses to link, an out-of-bounds emit traps in the host-side bounds check, and stack exhaustion is an interpreter trap — none of them crashed the process. A module importing anything else has nothing to link to: the rejection IS the jail."
}
EOF

echo "run-security-jail: PASS — evidence in $ART"
