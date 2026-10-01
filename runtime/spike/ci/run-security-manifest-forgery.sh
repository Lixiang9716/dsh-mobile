#!/bin/sh
# runtime/spike/ci/run-security-manifest-forgery.sh — the CLI proof run for
# the adversarial leg `security.manifest-forgery` (docs/security-threat-
# model.md, surface "marketplace supply chain"): a five-rung pipeline
# forgery ladder (capability escalation past a stale trust record and past
# fully recomputed trust, entry replacement, an id swap, an old package
# against the current anchor — every one rejected with zero staging), then
# the FRESHNESS rung: a stale-but-VALID catalog (honestly signed old index,
# served by this runner's loopback hosting — the model for a compromised
# mirror serving what the publisher once published) replayed through the
# resolver, and the control face (an honest package still installs).
#
# The catalog is authored with the LANDED publisher tooling
# (tools/gen-marketplace-index.mjs) over a staged dsh-echo@0.9.0 tree — a
# genuinely honest, correctly signed OLD index, fixed TEST seed (the same
# dsh-market-1 test key the marketplace.install leg pins). The production
# keys live only in the signing CI.
#
# usage: run-security-manifest-forgery.sh [--art-dir DIR] [--skip-build]
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/spike"

ART_DIR="$ROOT/runtime/spike/artifacts/macos-cli-security-manifest-forgery"
GENERATED_AT="2026-09-01T00:00:00Z"
# The dsh-market-1 TEST seed — byte-identical to run-marketplace-install-e2e.sh's.
SEED_1="a7b0c9d1e3f24506718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8"
WAIT_DEADLINE_SECONDS=15

# 1. vendored upstream closure + the wasm3/iSH materialization the host needs.
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh
sh vendor/ensure-ish.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-spike-cli ] || sh host/build.sh

# 3. loopback file hosting + the STALE-BUT-VALID catalog: one honestly signed
#    dsh-echo@0.9.0 entry (an OLD version of the honest package the scenario
#    also builds in memory), written as index-rollback.json.
CATALOG="$(mktemp -d /tmp/dsh-forge-catalog.XXXXXX)"
HOST_LOG="$(mktemp /tmp/dsh-forge-host.XXXXXX)"
cleanup() {
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    rm -rf "$CATALOG" "$HOST_LOG"
}
trap cleanup EXIT INT TERM

node ci/mock-market-hosting.mjs "$CATALOG" > "$HOST_LOG" 2>&1 &
SERVER_PID=$!
polled=0
until grep -s '^MARKET_BASE_URL=' "$HOST_LOG" > /dev/null; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "forge: hosting died before announcing:" >&2
        cat "$HOST_LOG" >&2
        exit 1
    fi
    polled=$((polled + 1))
    if [ "$polled" -gt $((WAIT_DEADLINE_SECONDS * 20)) ]; then
        echo "forge: hosting did not announce within ${WAIT_DEADLINE_SECONDS}s" >&2
        exit 1
    fi
    sleep 0.05
done
MARKET_URL="$(sed -n 's/^MARKET_BASE_URL=//p' "$HOST_LOG" | head -1)"
echo "forge: hosting at $MARKET_URL" >&2

# The old tree: dsh-echo@0.9.0, honest service, one fs requirement.
mkdir -p "$CATALOG/src/dsh-echo"
cat > "$CATALOG/src/dsh-echo/manifest.json" <<'EOF'
{
  "schemaVersion": 1,
  "id": "dsh-echo",
  "version": "0.9.0",
  "type": "service",
  "entry": "index.js",
  "capabilities": { "required": ["fsRead", "fsWrite"], "optional": [] },
  "hooks": { "activate": "activate" }
}
EOF
cat > "$CATALOG/src/dsh-echo/index.js" <<'EOF'
// dsh-echo v0.9.0 — the honestly published OLD release.
export const activate = () => "echo";
EOF
SEED_1_B64="$(node -e 'process.stdout.write(Buffer.from(process.argv[1], "hex").toString("base64"))' "$SEED_1")"
node ci/market-rollback-index.mjs "$CATALOG" "$MARKET_URL" "$SEED_1_B64" "$GENERATED_AT"
mv "$CATALOG/index.json" "$CATALOG/index-rollback.json"
echo "forge: stale-but-valid catalog staged (generatedAt $GENERATED_AT)" >&2

# 4. run the scenario and verify one-to-one.
mkdir -p "$ART_DIR"
LOG="$ART_DIR/logs.txt"
rm -f "$LOG"
RC=0
(cd . && ./build/dsh-spike-cli . scenario/security-manifest-forgery.js --http \
    --env "DSH_MARKET_URL=$MARKET_URL" > "$LOG" 2>&1) || RC=$?
grep '^dsh.spike.log:' "$LOG" > "$ART_DIR/scenario.jsonl" || true
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/security-manifest-forgery.json" \
    --log "$LOG" --out "$ART_DIR/verdict.json"
if [ "$RC" -ne 0 ]; then
    echo "   FAIL: the host exited $RC (crash, or the scenario reported failure — see $LOG)" >&2
    exit 1
fi

# 5. the receipt (what this run proves; the freshness verdict is quoted from
#    the run's own records, generated not hardcoded).
ROLLBACK_OUTCOME="$(sed -n 's/.*"event":"forge.rollback.catalog","outcome":"\([a-z]*\)".*/\1/p' "$ART_DIR/scenario.jsonl" | head -1)"
if [ "$ROLLBACK_OUTCOME" != "installed" ] && [ "$ROLLBACK_OUTCOME" != "rejected" ]; then
    echo "   FAIL: no readable forge.rollback.catalog outcome in the log" >&2
    exit 1
fi
if [ "$ROLLBACK_OUTCOME" = "installed" ]; then
    FINDING="HIGH FINDING (recorded, not hidden): the stale-but-valid catalog REPLAYED into an install — dsh-echo@0.9.0 landed through the resolver (the pinned key's own old signature verifies; the catalog carries no freshness anchor). See docs/security-threat-model.md, surface 'marketplace supply chain (freshness)'."
else
    FINDING="the replayed catalog was rejected by the client — a freshness guard is in force."
fi
cat > "$ART_DIR/receipt.json" <<EOF
{
 "host": "macOS $(uname -m) (the desktop CLI, no simulator)",
 "phase": "security adversarial leg 2/4 — the install pipeline under a manifest forgery ladder + a stale-catalog replay (docs/security-threat-model.md)",
 "launchConfiguration": "./build/dsh-spike-cli . scenario/security-manifest-forgery.js --http --env DSH_MARKET_URL=<loopback, ephemeral>",
 "scenarios": [
  {
   "id": "security.manifest-forgery",
   "checker": "test/e2e/scenarios/security-manifest-forgery.json",
   "result": "pass",
   "note": "5/5 pipeline forgeries rejected (capability escalation past a stale anchor and past recomputed trust, entry replacement, id swap, old-package rollback — codes integrity/capability/integrity/manifest/integrity) with zero staging and no journal; the control honest package installed after the whole ladder"
  }
 ],
 "audit": "one forge.case record per attack (codes pinned by the checker); staging absence asserted by the scenario per transaction; journal absence asserted after the ladder",
 "freshness": "$FINDING",
 "notes": "The §7.1 signed-catalog ladder (bad signature / unknown key / hostile mirror / metadata error) is NOT duplicated here — it lives in marketplace.install. This leg owns the package face and the freshness face."
}
EOF

echo "run-security-manifest-forgery: PASS — evidence in $ART_DIR (freshness: $ROLLBACK_OUTCOME)"
