#!/bin/sh
# runtime/dsh/ci/run-marketplace-install-e2e.sh — the CLI proof run for the
# plugin marketplace (data-protocols.md §7, the signed catalog): boots the
# loopback FILE HOSTING (mock-market-hosting.mjs — the "plain file hosting" of
# the adopted proposal's v0 model), authors the catalog from system-plugins/
# with the LANDED publisher tooling — tools/gen-marketplace-index.mjs for the
# honest single-signed index and tools/marketplace-rotate-key.mjs
# window-index for the §7.2 dual-signed window (the same tools the
# marketplace-publish workflow drives; fixed TEST seeds — the production
# marketplace keys live only in the signing CI) — derives the tamper-ladder +
# rotation variants (market-test-indexes.mjs), and drives
# scenario/marketplace-install.js through the REAL gateway httpFetch
# (--http, loopback-only): pure-JS ed25519 verification, resolver lookup,
# the UNCHANGED installFromFetch, the §7.2 rotation drill, and the §7.1
# tamper ladder (bad signature / unknown key / hostile-mirror blob mismatch /
# manifest metadata mismatch), each rejection audited with zero staging.
#
# The captured log is verified one-to-one against
# test/e2e/scenarios/marketplace-install.json. Artifacts:
# runtime/dsh/artifacts/macos-cli-marketplace-install/ (the catalog itself
# is reproducible from the repo — temp dir, never committed).
#
# usage: run-marketplace-install-e2e.sh   (artifacts: .../macos-cli-marketplace-install)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

ART_DIR="$ROOT/runtime/dsh/artifacts/macos-cli-marketplace-install"
GENERATED_AT="2026-10-01T00:00:00Z"
# FIXED TEST-ONLY SEEDS (32 bytes each): dsh-market-1 (the pinned outgoing
# key — its public half is hardcoded in the scenario as the repo-config pin),
# dsh-market-2 (the rotation successor), attacker-key-9 (the unknown-key
# rung). These prove the machinery; they are NOT marketplace keys.
SEED_1="a7b0c9d1e3f24506718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8"
SEED_2="d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b"
SEED_ATK="e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6"
WAIT_DEADLINE_SECONDS=15

# 1. vendored upstream closure: pinned + sha256-verified. ensure-ish.sh is
#    named EXPLICITLY (siblings run-upstream-parity.sh / check-quickjs-boot-
#    parse.sh do the same): the spike host links the iSH engine, ensure.sh
#    does not materialize it, and a fresh checkout has no build/ binary —
#    without this line the leg is unreproducible there.
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh
sh vendor/ensure-ish.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-spike-cli ] || sh host/build.sh

# 3. loopback file hosting FIRST (the generator needs its base URL), then the
#    catalog: honest index + packages from system-plugins, then the tamper
#    ladder / rotation drill variants against the same packages.
CATALOG="$(mktemp -d /tmp/dsh-market-catalog.XXXXXX)"
MARKET_LOG="$(mktemp /tmp/dsh-market-server.XXXXXX)"
node ci/mock-market-hosting.mjs "$CATALOG" > "$MARKET_LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    rm -rf "$CATALOG" "$MARKET_LOG"
}
trap cleanup EXIT INT TERM

MARKET_URL=""
polled=0
until grep -s '^MARKET_BASE_URL=' "$MARKET_LOG" > /dev/null; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "mock market server died before announcing its endpoint:" >&2
        cat "$MARKET_LOG" >&2
        exit 1
    fi
    polled=$((polled + 1))
    if [ "$polled" -gt $((WAIT_DEADLINE_SECONDS * 20)) ]; then
        echo "mock market server did not announce within ${WAIT_DEADLINE_SECONDS}s" >&2
        exit 1
    fi
    sleep 0.05
done
MARKET_URL="$(sed -n 's/^MARKET_BASE_URL=//p' "$MARKET_LOG" | head -1)"
echo "mock market server: $MARKET_URL" >&2

# The seeds reach the publisher tools in their b64 form (the tools take
# MARKETPLACE_SIGNING_KEY-style base64; the variant tool below keeps hex).
hex2b64() { node -e 'process.stdout.write(Buffer.from(process.argv[1], "hex").toString("base64"))' "$1"; }
SEED_1_B64="$(hex2b64 "$SEED_1")"
SEED_2_B64="$(hex2b64 "$SEED_2")"

# The HONEST catalog: single-signed by dsh-market-1 — the same invocation
# shape the marketplace-publish workflow drives (its --out/--key-seed flags),
# with a FIXED generatedAt so the bytes are reproducible run to run.
gen_honest() {
    node "$ROOT/tools/gen-marketplace-index.mjs" \
        --system-plugins "$ROOT/runtime/dsh/system-plugins" \
        --out "$CATALOG" \
        --base-url "$MARKET_URL" \
        --generated-at "$GENERATED_AT" \
        --key-id dsh-market-1 \
        --key-seed "$SEED_1_B64"
}
gen_honest

# The §7.2 rotation WINDOW document (dual-signed outgoing + incoming) from
# the landed runbook tool — then moved aside so the honest index.json keeps
# its name (the drill serves both documents side by side).
node "$ROOT/tools/marketplace-rotate-key.mjs" window-index \
    --system-plugins "$ROOT/runtime/dsh/system-plugins" \
    --out "$CATALOG" \
    --base-url "$MARKET_URL" \
    --generated-at "$GENERATED_AT" \
    --key-id dsh-market-1 \
    --current-seed "$SEED_1_B64" \
    --new-seed "$SEED_2_B64" \
    --new-key-id dsh-market-2
mv "$CATALOG/index.json" "$CATALOG/index-rotation-window.json"
gen_honest

node ci/market-test-indexes.mjs "$CATALOG" "$MARKET_URL" "$SEED_1" "$SEED_2" "$SEED_ATK"

# 4. run the scenario (--http: loopback httpFetch; --env: the catalog URL)
#    and verify one-to-one.
./build/dsh-spike-cli . scenario/marketplace-install.js \
    --http \
    --env "DSH_MARKET_URL=$MARKET_URL" > logs-marketplace-install.txt
mkdir -p "$ART_DIR"
cp logs-marketplace-install.txt "$ART_DIR/logs.txt"
grep '^dsh.spike.log:' logs-marketplace-install.txt > "$ART_DIR/scenario.jsonl"
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/marketplace-install.json" \
    --log logs-marketplace-install.txt \
    --out "$ART_DIR/verdict.json"

# 5. the receipt (what this run proves; one JSON document).
EVENTS="$(grep -c '"scenario":"marketplace.install"' logs-marketplace-install.txt)"
FS_BLOB="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entries.find(e=>e.id==="dsh-fs").blobSha256)' "$CATALOG/index.json" 2>/dev/null || echo unknown)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "quickjsTag": "v0.17.0",
  "quickjsCommit": "6d46d07d04041b40f4f49eaa7fdebe44c314c699",
  "scenario": "marketplace.install",
  "proves": [
    "the signed catalog over the FROZEN package format (data-protocols.md §7, proposal 2026-10-01-plugin-marketplace ADOPTED): the loopback file hosting serves the index + package tarballs CI authored from system-plugins/ — 9 entries, generatedAt pinned for reproducible bytes, catalog reproducible from the repo (temp dir, not committed)",
    "PURE-JS ed25519 verification with ZERO new gateway primitives: ed25519.js (RFC 8032 verify-only, BigInt over quickjs-ng) self-tests against the RFC vectors (2 positives + 3 negatives) before any catalog is trusted, then verifies the catalog signature node-crypto-side signed (tools/gen-marketplace-index.mjs signs the canonical JSON via the SHARED canonical-json.js — signer and verifier cannot drift)",
    "the resolver seam: index fetch over the REAL gateway httpFetch (loopback), §7.1 signature verification, id@range lookup (^0.1.0 and * both exercised), and the entry's signed trust record {blobSha256, manifestSha256} passed THROUGH to the UNCHANGED installFromFetch — the committed receipt's blobSha256 equals the catalog entry's (the passthrough proof); the catalog-installed dsh-fs is a REAL plugin (loaded via the registry, fs write/read round-trips)",
    "the §7.2 key rotation drill: the dual-signed window index is accepted under the pinned outgoing key and dsh-market-2 is LEARNED (only through a verified dual signature); the post-window single-signed index is accepted by the window-observing resolver (rotation completed) and REFUSED unknown-key by a fresh stale pin (rotated-key-outside-window)",
    "the §7.1 tamper ladder, each rung InstallRejected with its own code, audited, ZERO staging trees, journal growth untouched, installed tree intact: bad-signature (hosting flips a signature byte), unknown-key (a self-consistent catalog under attacker-key-9 — trust is the pin, not the document), blob-mismatch (the honest catalog against a hostile mirror — served bytes flipped behind a control endpoint; the signed trust record catches what the transport cannot), manifest-mismatch (publisher metadata error, catalog honestly re-signed — the §4 trust-record cross-check refuses what the signature alone cannot)"
  ],
  "catalog": {
    "authoring": "tools/gen-marketplace-index.mjs --system-plugins runtime/dsh/system-plugins (the landed publisher tool; deterministic ustar, mtime 0) + tools/marketplace-rotate-key.mjs window-index for the §7.2 document; fixed seeds — TEST keys only",
    "entries": 9,
    "dsh-fs-blobSha256": "$FS_BLOB",
    "generatedAt": "$GENERATED_AT",
    "pinnedKey": "dsh-market-1 (repo-config stand-in hardcoded in the scenario; production key lives in the signing CI, never in the repo)"
  },
  "checker": "test/e2e/scenarios/marketplace-install.json",
  "events": $EVENTS,
  "determinism": "fixed seeds + fixed generatedAt + deterministic ustar + ephemeral-port URLs normalized to paths in the log; catalog bytes reproducible from the repo",
  "exitCode": 0
}
EOF
echo "marketplace.install: artifacts in $ART_DIR (verdict, logs, receipt)" >&2
