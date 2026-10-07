#!/bin/sh
# runtime/dsh/ci/run-perf-baseline.sh — the CLI proof run for the
# performance MEASUREMENT leg (scenario `perf.baseline`): one full cold boot
# (mobile profile over the mock route) + one mock session turn (the page's
# own wire: session/create → session/prompt → whenIdle) + one signed-catalog
# install (resolver refresh + ed25519 verify + installFromFetch commit),
# every in-runtime number emitted into the scenario's event stream (D8) and
# extracted from the captured log into the receipt. The PROCESS-level cold
# start (spawn → PASS) and the BYTE facts (the generated SpikeBundle.c, the
# market tgz) are shell-side measurements — jittery numbers never enter the
# deterministic log (E2E by logs), they live in the receipt only.
#
# Bundle bytes: hosts/ios/Tools/gen_bundle_header.py regenerates the iOS
# embed (App/Generated/ is gitignored build output since the D9 flip —
# regenerating here leaves the index untouched; the closures gate runs the
# same generator). Market tgz bytes: the catalog this runner authors from
# system-plugins/ with the LANDED publisher tooling (fixed TEST seeds +
# fixed generatedAt — the same invocation shape run-marketplace-install-e2e.sh
# drives, so the tgz bytes are deterministic).
#
# The captured log is verified one-to-one against
# test/e2e/scenarios/perf-baseline.json. Artifacts:
# runtime/dsh/artifacts/macos-cli-perf-baseline/.
#
# usage: run-perf-baseline.sh   (artifacts: .../macos-cli-perf-baseline)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

ART_DIR="$ROOT/runtime/dsh/artifacts/macos-cli-perf-baseline"
GENERATED_AT="2026-10-01T00:00:00Z"
# The TEST catalog's dsh-market-1 seed — the same fixed test seed the
# marketplace-install leg pins (production keys live only in the signing CI).
SEED_1="a7b0c9d1e3f24506718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8"
MOCK_KEY="mock-key-0001"
WAIT_DEADLINE_SECONDS=15

# 1. vendored upstream closure: pinned + sha256-verified.
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-cli ] || sh host/build.sh

# 3. byte facts (shell-side, receipt-only): the generated iOS bundle and the
#    market tgz this runner authors. The bundle generator needs the same
#    materialized closure step 1 produced.
python3 "$ROOT/hosts/ios/Tools/gen_bundle_header.py" > /dev/null
BUNDLE_C_BYTES="$(stat -f %z "$ROOT/hosts/ios/App/Generated/SpikeBundle.c")"

# 4. loopback servers: the mock LLM (one scripted success) + the mock market
#    hosting with the honest single-signed catalog (condition-polled
#    announces, rule 8).
MOCK_LOG="$(mktemp /tmp/dsh-mock-llm-perf.XXXXXX)"
DSH_MOCK_SEQUENCE="success" node ci/mock-llm-server.mjs > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
CATALOG="$(mktemp -d /tmp/dsh-perf-market.XXXXXX)"
MARKET_LOG="$(mktemp /tmp/dsh-perf-market-server.XXXXXX)"
node ci/mock-market-hosting.mjs "$CATALOG" > "$MARKET_LOG" 2>&1 &
MARKET_PID=$!
cleanup() {
    kill "$MOCK_PID" "$MARKET_PID" 2>/dev/null || true
    wait "$MOCK_PID" "$MARKET_PID" 2>/dev/null || true
    rm -rf "$CATALOG" "$MOCK_LOG" "$MARKET_LOG"
}
trap cleanup EXIT INT TERM

wait_announce() {
    _file="$1"; _pid="$2"; _tag="$3"
    polled=0
    until grep -s "$_tag=" "$_file" > /dev/null; do
        if ! kill -0 "$_pid" 2>/dev/null; then
            echo "perf-baseline: $_tag server died before announcing:" >&2
            cat "$_file" >&2
            exit 1
        fi
        polled=$((polled + 1))
        if [ "$polled" -gt $((WAIT_DEADLINE_SECONDS * 20)) ]; then
            echo "perf-baseline: no $_tag announce within ${WAIT_DEADLINE_SECONDS}s" >&2
            exit 1
        fi
        sleep 0.05
    done
}
wait_announce "$MOCK_LOG" "$MOCK_PID" MOCK_BASE_URL
wait_announce "$MARKET_LOG" "$MARKET_PID" MARKET_BASE_URL
MOCK_URL="$(sed -n 's/^MOCK_BASE_URL=//p' "$MOCK_LOG" | head -1)"
MARKET_URL="$(sed -n 's/^MARKET_BASE_URL=//p' "$MARKET_LOG" | head -1)"
echo "perf-baseline: mock llm $MOCK_URL / market $MARKET_URL" >&2

SEED_1_B64="$(node -e 'process.stdout.write(Buffer.from(process.argv[1], "hex").toString("base64"))' "$SEED_1")"
node "$ROOT/tools/gen-marketplace-index.mjs" \
    --system-plugins "$ROOT/runtime/dsh/system-plugins" \
    --out "$CATALOG" \
    --base-url "$MARKET_URL" \
    --generated-at "$GENERATED_AT" \
    --key-id dsh-market-1 \
    --key-seed "$SEED_1_B64"
TGZ_BYTES="$(stat -f %z "$CATALOG/dsh-fs@0.1.0.tgz")"

# 5. run the scenario with the process-level cold start measured around it
#    (node's Date.now on both sides — millisecond wall clock; receipt-only).
PROC_START="$(node -e 'console.log(Date.now())')"
./build/dsh-cli . scenario/perf-baseline.js \
    --http \
    --env "DSH_MOCK_LLM_URL=$MOCK_URL" \
    --env "DSH_MOCK_LLM_KEY=$MOCK_KEY" \
    --env "DSH_MARKET_URL=$MARKET_URL" > logs-perf-baseline.txt
PROC_END="$(node -e 'console.log(Date.now())')"
PROC_COLD_START_MS=$((PROC_END - PROC_START))

# 6. one-to-one verification, then extract the measured numbers from the
#    SAME captured log into the receipt.
mkdir -p "$ART_DIR"
cp logs-perf-baseline.txt "$ART_DIR/logs.txt"
grep '^dsh.spike.log:' logs-perf-baseline.txt > "$ART_DIR/scenario.jsonl"
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/perf-baseline.json" \
    --log logs-perf-baseline.txt \
    --out "$ART_DIR/verdict.json"

EVENTS="$(grep -c '"scenario":"perf.baseline"' logs-perf-baseline.txt)"
MEASURED="$(node -e '
const fs = require("fs");
const rows = fs.readFileSync(process.argv[1], "utf8").split("\n")
  .filter((l) => l.startsWith("dsh.spike.log:"))
  .map((l) => JSON.parse(l.slice("dsh.spike.log:".length)))
  .map((r) => (Array.isArray(r.data) ? r.data[0] : null))
  .filter((p) => p && p.scenario === "perf.baseline");
const pick = (event) => rows.find((p) => p.event === event) ?? null;
const boot = pick("perf.cold.boot");
const turn = pick("perf.session.turn");
const refresh = pick("perf.catalog.refresh");
const install = pick("perf.install.commit");
if (!boot || !turn || !refresh || !install) {
  console.error("perf-baseline: a measured event is missing from the log"); process.exit(1);
}
console.log(JSON.stringify({
  coldBootMs: boot.bootMs, sessionTurnMs: turn.turnMs,
  catalogRefreshMs: refresh.refreshMs, installCommitMs: install.installMs,
}));
' "$ART_DIR/scenario.jsonl")"

cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "quickjsPin": "0.17.0+fork-tostring+async-context+tc39+promise-mark (63b33ea5)",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim)",
  "scenario": "perf.baseline",
  "measured": $MEASURED,
  "processColdStartMs": $PROC_COLD_START_MS,
  "bundle": {
    "spikeBundleCBytes": $BUNDLE_C_BYTES,
    "marketTgzBytes": $TGZ_BYTES,
    "note": "SpikeBundle.c regenerated by hosts/ios/Tools/gen_bundle_header.py (gitignored build output since the D9 flip); dsh-fs@0.1.0.tgz authored from system-plugins/ with fixed TEST seeds + generatedAt $GENERATED_AT (deterministic bytes)"
  },
  "machine": {
    "os": "$(uname -s) $(uname -sr)",
    "arch": "$(uname -m)",
    "chip": "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)",
    "memoryBytes": "$(sysctl -n hw.memsize 2>/dev/null || echo unknown)",
    "node": "$(node --version)",
    "note": "numbers are machine-local wall-clock; budgets carry margins, the gate is warn-tier"
  },
  "checker": "test/e2e/scenarios/perf-baseline.json",
  "events": $EVENTS,
  "determinism": "jittery numbers never enter the deterministic log — the manifest pins events + stable fields only; measured values live here and in baselines/perf-baseline.json",
  "exitCode": 0
}
EOF
echo "perf.baseline: artifacts in $ART_DIR (verdict, logs, receipt)" >&2
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const m = r.measured;
console.error(`perf.baseline: coldBootMs=${m.coldBootMs} sessionTurnMs=${m.sessionTurnMs} catalogRefreshMs=${m.catalogRefreshMs} installCommitMs=${m.installCommitMs} processColdStartMs=${r.processColdStartMs} bundleC=${r.bundle.spikeBundleCBytes} tgz=${r.bundle.marketTgzBytes}`);
' "$ART_DIR/receipt.json" >&2
