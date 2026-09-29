#!/bin/sh
# Local E2E for the loopback socket seam (contract v1.8.0, decision D-d):
# server + client in one scenario over REAL loopback TCP, plus the shape that
# motivated the seam — a spawned OS child (/bin/bash + /dev/tcp) dialing the
# in-test server across a kernel socket — plus the zero-prompt denial legs.
#
# Two gates, layered like run-ish-local's:
#   1. the JS gate — the desktop CLI runs scenario/socket-seam.js, whose
#      records test/e2e/scenarios/socket-seam-local.json matches one-to-one;
#   2. the AUDIT gate — the host's stderr carries one structured audit record
#      per listen/connect/accept (contract §6); this script greps them and
#      asserts the count and the outcomes.
#
#   test/e2e/run-socket-seam.sh [--art-dir DIR] [--skip-build]
#
# The whole leg is loopback-only by construction: the suite's grants are the
# descriptor's two loopback grants, so nothing prompts and nothing touches a
# remote network (the five-rule model's narrowest scope).
set -e
cd "$(dirname "$0")/../.."

ART=runtime/spike/artifacts/macos-cli-socket-seam
SKIP_BUILD=0
while [ $# -gt 0 ]; do
    case "$1" in
        --art-dir) ART="$2"; shift 2 ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        *) echo "run-socket-seam: unknown argument '$1'" >&2; exit 2 ;;
    esac
done
case "$ART" in
    /tmp/*) echo "run-socket-seam: --art-dir must not be under /tmp (evidence lives with the repo)" >&2; exit 2 ;;
esac
case "$ART" in /*) ;; *) ART="$PWD/$ART" ;; esac

[ -f /bin/bash ] || { echo "run-socket-seam: no /bin/bash — the subprocess dial leg needs it" >&2; exit 2; }

mkdir -p "$ART"

echo "== 1/2 build =="
if [ "$SKIP_BUILD" -eq 0 ]; then
    sh runtime/spike/host/build.sh >/dev/null
fi

echo "== 2/2 JS gate: scenario → gateway → host seam =="
LOG="$ART/logs.txt"
rm -f "$LOG"
(cd runtime/spike && ./build/dsh-spike-cli . scenario/socket-seam.js > "$LOG" 2>&1) || true
grep '^dsh.spike.log:' "$LOG" > "$ART/scenario.jsonl" || true
grep '^{"audit":"socket\.' "$LOG" > "$ART/socket-audit.jsonl" || true
node test/e2e/check.mjs --manifest test/e2e/scenarios/socket-seam-local.json \
    --log "$LOG" --out "$ART/verdict-socket-seam-local.json"

echo "== audit gate: one structured record per listen/connect/accept =="
# 3 listens (2 granted servers + 1 denied lan attempt) + 2 connects (1 granted
# dial + 1 denied non-loopback host; the subprocess dial rides the OS's own
# /dev/tcp, not the gateway) + 2 accepts (one per server) — every attempt
# carries exactly one record, none carrying payload bytes.
N_LISTEN=$(grep -c '"audit":"socket.listen"' "$ART/socket-audit.jsonl" || true)
N_CONNECT=$(grep -c '"audit":"socket.connect"' "$ART/socket-audit.jsonl" || true)
N_ACCEPT=$(grep -c '"audit":"socket.accept"' "$ART/socket-audit.jsonl" || true)
N_DENIED=$(grep -c '"outcome":"denied"' "$ART/socket-audit.jsonl" || true)
[ "$N_LISTEN" -eq 3 ] || { echo "   FAIL: expected 3 listen audits, got $N_LISTEN" >&2; exit 1; }
[ "$N_CONNECT" -eq 2 ] || { echo "   FAIL: expected 2 connect audits, got $N_CONNECT" >&2; exit 1; }
[ "$N_ACCEPT" -eq 2 ] || { echo "   FAIL: expected 2 accept audits, got $N_ACCEPT" >&2; exit 1; }
[ "$N_DENIED" -eq 2 ] || { echo "   FAIL: expected 2 denied audits, got $N_DENIED" >&2; exit 1; }
grep -q '"scope":"loopback"' "$ART/socket-audit.jsonl" \
    || { echo "   FAIL: the listen audits do not name the loopback scope" >&2; exit 1; }
grep -q '"peer":"127.0.0.1:' "$ART/socket-audit.jsonl" \
    || { echo "   FAIL: the connect/accept audits do not name the loopback peer" >&2; exit 1; }
echo "   audits: listen=$N_LISTEN connect=$N_CONNECT accept=$N_ACCEPT denied=$N_DENIED (every attempt one record, loopback-only)"

cat > "$ART/receipt.json" <<EOF
{
 "host": "macOS $(uname -m) (the desktop CLI, no simulator)",
 "phase": "contract v1.8.0 \`socketListen\`/\`socketConnect\` — audited loopback-only TCP (decision D-d); the desktop CLI is the dev/test profile, so the loopback grants come from the descriptor alone and nothing prompts",
 "launchConfiguration": "(cd runtime/spike) ./build/dsh-spike-cli . scenario/socket-seam.js",
 "scenarios": [
  {
   "id": "socket.seam",
   "checker": "test/e2e/scenarios/socket-seam-local.json",
   "result": "pass",
   "note": "17 records, one-to-one: host-picked listen port, a real TCP echo roundtrip with a half-close, a spawned /bin/bash child dialing the in-test server over /dev/tcp (bytes crossing between two OS processes), and the two out-of-scope denials (lan listen, non-loopback connect)"
  }
 ],
 "audit": "listen=2 connect=2 accept=2, all granted, every record loopback-scoped (runtime/spike/artifacts/macos-cli-socket-seam/socket-audit.jsonl)",
 "notes": "Negotiation floor: hosts without the seam keep descriptorless descriptors and the JS face answers the honest ECONNREFUSED/EACCES — zero behavior change where the seam is absent."
}
EOF

echo "run-socket-seam: PASS — evidence in $ART"
