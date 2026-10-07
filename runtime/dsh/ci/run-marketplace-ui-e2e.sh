#!/bin/sh
# runtime/dsh/ci/run-marketplace-ui-e2e.sh — the CLI proof run for the
# plugin marketplace panel (scenario `marketplace.ui.flow`): boots the mobile
# profile, creates the write surface with `fullCoverage: true` AND the
# marketplace opt-in (the coverage-plane rows claimed exactly as on device),
# and walks the page's flow at the same wire boundary the page uses:
#
#   browse    → marketplace/index: the resolver fetches the loopback
#               catalog's index.json over the REAL gateway httpFetch and
#               verifies its ed25519 signature (node:crypto/OpenSSL-signed —
#               the independent implementation our pure-JS verifier must
#               agree with);
#   install   → the marketplace/install stream: one real transaction
#               (index.verified → resolved → fetch.start → … → committed →
#               receipt), the package bytes over real loopback HTTP, the
#               catalog's trust record driving the UNCHANGED installer;
#   installed → the receipts journal's committed install;
#   remove    → the tree unlinked, the §4 remove receipt appended, both
#               views refreshed.
#
# The mock catalog is a NODE package (node:http): it runs node-side, outside
# quickjs, started/killed by this script (condition-polled announce, rule 8).
# The captured log is verified one-to-one against
# test/e2e/scenarios/marketplace-ui-flow.json. Artifacts:
# runtime/dsh/artifacts/macos-cli-marketplace-ui/.
#
# The key audit: the fixed test-only ed25519 SEED (mock-market-server.mjs)
# is never a secret, but it must never appear in the capture either — the
# runner greps for it and for the private DER prefix.
#
# usage: run-marketplace-ui-e2e.sh   (artifacts: .../macos-cli-marketplace-ui)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

ART_DIR="$ROOT/runtime/dsh/artifacts/macos-cli-marketplace-ui"
MOCK_WAIT_DEADLINE_SECONDS=15
SEED_HEX="3a6b7d0f1e2c3b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d6e"

# 1. vendored upstream closure: pinned + sha256-verified.
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-spike-cli ] || sh host/build.sh

# 3. start the mock catalog server and wait for the announce (condition
#    poll with a deadline, rule 8).
MOCK_LOG="$(mktemp /tmp/dsh-mock-market.XXXXXX)"
node ci/mock-market-server.mjs > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() {
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
    rm -f "$MOCK_LOG"
}
trap cleanup EXIT INT TERM

polled=0
until grep -s '^MARKET_BASE_URL=' "$MOCK_LOG" > /dev/null; do
    if ! kill -0 "$MOCK_PID" 2>/dev/null; then
        echo "e2e: FAIL — the mock market server died before announcing" >&2
        exit 1
    fi
    if [ "$polled" -ge $((MOCK_WAIT_DEADLINE_SECONDS * 20)) ]; then
        echo "e2e: FAIL — no MARKET_BASE_URL announce within ${MOCK_WAIT_DEADLINE_SECONDS}s" >&2
        exit 1
    fi
    sleep 0.05
    polled=$((polled + 1))
done
MARKET_URL="$(sed -n 's/^MARKET_BASE_URL=//p' "$MOCK_LOG" | head -1)"
echo "mock market server: $MARKET_URL" >&2

# The HOST-SIDE PIN (proposal rule 2): the verification public key derived
# out-of-band from the runner's own knowledge of the fixture key — the
# scenario pins the resolver with it, so a wholesale keys+index+signature
# swap (served at /index-foreign.json) is refused. Real embeds take the pin
# from repo config; this fixture's key is committed test material.
PUB_B64="$(node -e "
const { createPrivateKey, createPublicKey } = require('node:crypto');
const seed = Buffer.from('$SEED_HEX', 'hex');
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
process.stdout.write(Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64'));
")"
echo "host-side pin: $PUB_B64" >&2

# 4. run the scenario (--http: the CLI's loopback httpFetch backend — the
#    catalog + package transport; --env: the launch-env snapshot) and verify
#    one-to-one.
./build/dsh-spike-cli . scenario/marketplace-ui.js \
    --http \
    --env "DSH_MARKET_URL=$MARKET_URL" \
    --env "DSH_MARKET_PUBKEY_B64=$PUB_B64" > logs-marketplace-ui.txt
mkdir -p "$ART_DIR"
cp logs-marketplace-ui.txt "$ART_DIR/logs.txt"
grep '^dsh.spike.log:' logs-marketplace-ui.txt > "$ART_DIR/scenario.jsonl"
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/marketplace-ui-flow.json" \
    --log logs-marketplace-ui.txt \
    --out "$ART_DIR/verdict.json"

# 5. the key audit: the signing seed never reaches the capture.
if grep -F -e "$SEED_HEX" -e "302e020100300506032b657004220420" logs-marketplace-ui.txt >/dev/null; then
    echo "e2e: FAIL — the signing key material leaked into the log" >&2
    exit 1
fi

# 6. the receipt (what this run proves; one JSON document).
EVENTS="$(grep -c '"scenario":"marketplace.ui.flow"' logs-marketplace-ui.txt)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "quickjsTag": "v0.17.0",
  "quickjsCommit": "6d46d07d04041b40f4f49eaa7fdebe44c314c699",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, tgz sha256-pinned by runtime/dsh/vendor/ensure-dsh.sh)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "marketplace.ui.flow",
  "proves": [
    "the browse view is the SIGNED catalog under a HOST-SIDE PIN (proposal rule 2): the resolver fetched the loopback index.json over the REAL gateway httpFetch, re-serialized its canonical form, required the signing key to EQUAL the runner's out-of-band pin, and the pure-JS ed25519 verifier accepted node:crypto/OpenSSL's signature — two independent implementations agreeing on the one new seam; the curve itself is pinned in the tree by test/panel/ed25519.test.js (RFC §7.1 vectors as fixed data + fresh OpenSSL-signed cases + tamper refusals)",
    "the tamper ladder's signature family really refuses: a flipped-summary index under the real key's signature rejects as marketplace/signature, and a wholesale keys+index+signature swap by a foreign key — self-consistent, exactly what a hosting attacker ships — rejects as marketplace/unknown-key against the pin; the digest-mismatch half of the ladder is the pipeline's own trust-record enforcement, already proven by install.full-cycle",
    "the install is the REAL transaction: one marketplace/install stream folded the pipeline's own steps (index.verified → resolved → fetch.start → fetch.status → fetch.body → blob.stored → digest.verified → manifest.validated → integrity.computed → negotiated → receipt.pending → staged.verified → promoted → committed → receipt) with the package bytes over real loopback HTTP — installFromFetch/install-pipeline consumed UNCHANGED with the catalog entry's blobSha256/manifestSha256 as the trust record",
    "the installed view reads the profile's receipts journal (the §4 data plane): exactly the committed install, with its plugins/ directory",
    "the remove leg is the §4 symmetric action: the tree unlinked, the append-only remove receipt appended, the installed view empty and the browse annotation reset to null afterwards",
    "the key audit is green: the signing seed and the PKCS8 prefix appear nowhere in the raw log"
  ],
  "checker": "test/e2e/scenarios/marketplace-ui-flow.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

echo "e2e: PASS $ART_DIR" >&2
