#!/bin/sh
# runtime/dsh/ci/run-leak-canary.sh — the CLI proof run for the leak CANARY
# leg (scenario `leak.canary`): boots the mobile profile ONCE against the
# loopback mock LLM (repeat-last script — the canary needs 100 scripted
# successes), drives N=100 mock session rounds over the page's own wire
# (session/create → session/prompt → whenIdle), and reads the engine heap
# watermark BEFORE and AFTER a forced collection through the spike host's
# __dshPerfProbe C hook (test infrastructure — a host global like
# __dshComplete; never a gateway primitive, never in a descriptor). Red =
# the post-GC watermark sits above the pre-GC one by more than the
# tolerance: the churn of 100 healthy rounds must be collectible.
#
# The captured log is verified one-to-one against
# test/e2e/scenarios/leak-canary.json. Artifacts:
# runtime/dsh/artifacts/macos-cli-leak-canary/.
#
# usage: run-leak-canary.sh   (artifacts: .../macos-cli-leak-canary)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

ART_DIR="$ROOT/runtime/dsh/artifacts/macos-cli-leak-canary"
MOCK_KEY="mock-key-0001"
MOCK_WAIT_DEADLINE_SECONDS=15

# 1. vendored upstream closure: pinned + sha256-verified.
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-cli ] || sh host/build.sh

# 3. the mock LLM server with a REPEAT-LAST success script — 100 rounds need
#    100 scripted successes (condition-polled announce, rule 8).
MOCK_LOG="$(mktemp /tmp/dsh-mock-llm-leak.XXXXXX)"
DSH_MOCK_SEQUENCE="success" DSH_MOCK_REPEAT_LAST=1 node ci/mock-llm-server.mjs \
    > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() {
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
    rm -f "$MOCK_LOG"
}
trap cleanup EXIT INT TERM

polled=0
until grep -s '^MOCK_BASE_URL=' "$MOCK_LOG" > /dev/null; do
    if ! kill -0 "$MOCK_PID" 2>/dev/null; then
        echo "leak-canary: the mock LLM server died before announcing" >&2
        exit 1
    fi
    if [ "$polled" -ge $((MOCK_WAIT_DEADLINE_SECONDS * 20)) ]; then
        echo "leak-canary: no MOCK_BASE_URL announce within ${MOCK_WAIT_DEADLINE_SECONDS}s" >&2
        exit 1
    fi
    sleep 0.05
    polled=$((polled + 1))
done
MOCK_URL="$(sed -n 's/^MOCK_BASE_URL=//p' "$MOCK_LOG" | head -1)"
echo "leak-canary: mock llm server $MOCK_URL (rounds=100, pinned with the manifest)" >&2

# 4. run the canary and verify one-to-one. A tripped canary exits nonzero
#    BEFORE check.mjs (the scenario's own verdict is the leak), so the
#    runner surfaces the leak loudly — the RED branch below copies the log,
#    writes the checker verdict for the record, and exits 1. The `|| ...`
#    capture is LOAD-BEARING under `set -eu`: a bare failing command would
#    kill the script on the spot and the whole RED branch would be
#    unreachable dead code (review #297 — proven with a minimal /bin/sh
#    repro before this fix).
CLI_RC=0
./build/dsh-cli . scenario/leak-canary.js \
    --http \
    --env "DSH_MOCK_LLM_URL=$MOCK_URL" \
    --env "DSH_MOCK_LLM_KEY=$MOCK_KEY" > logs-leak-canary.txt || CLI_RC=$?

mkdir -p "$ART_DIR"
cp logs-leak-canary.txt "$ART_DIR/logs.txt"
grep '^dsh.runtime.log:' logs-leak-canary.txt > "$ART_DIR/scenario.jsonl"

if [ "$CLI_RC" -ne 0 ]; then
    echo "leak-canary: RED — the canary tripped (see the verdict event in $ART_DIR/logs.txt)" >&2
    node "$ROOT/test/e2e/check.mjs" \
        --manifest "$ROOT/test/e2e/scenarios/leak-canary.json" \
        --log logs-leak-canary.txt \
        --out "$ART_DIR/verdict.json" || true
    exit 1
fi

node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/leak-canary.json" \
    --log logs-leak-canary.txt \
    --out "$ART_DIR/verdict.json"

# 5. the receipt (what this run proves; the growth numbers from the log).
EVENTS="$(grep -c '"scenario":"leak.canary"' logs-leak-canary.txt)"
GROWTH="$(node -e '
const fs = require("fs");
const rows = fs.readFileSync(process.argv[1], "utf8").split("\n")
  .filter((l) => l.startsWith("dsh.runtime.log:"))
  .map((l) => JSON.parse(l.slice("dsh.runtime.log:".length)))
  .map((r) => (Array.isArray(r.data) ? r.data[0] : null))
  .filter((p) => p && p.scenario === "leak.canary");
const verdict = rows.find((p) => p.event === "leak.canary.verdict");
if (!verdict) { console.error("leak-canary: no verdict event"); process.exit(1); }
console.log(JSON.stringify({
  beforeMemoryUsedSize: verdict.beforeMemoryUsedSize,
  afterMemoryUsedSize: verdict.afterMemoryUsedSize,
  growthBytes: verdict.growthBytes, toleranceBytes: verdict.toleranceBytes,
}));
' "$ART_DIR/scenario.jsonl")"

cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "quickjsPin": "0.17.0+fork-tostring+async-context+tc39+promise-mark (63b33ea5)",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim)",
  "scenario": "leak.canary",
  "rounds": 100,
  "heap": $GROWTH,
  "method": "both watermarks are gc-mode readings (JS_RunGC then JS_ComputeMemoryUsage via the __dshPerfProbe host test hook — not a gateway primitive); red = post-GC watermark above the pre-GC one by more than the tolerance",
  "falsification": "a deliberately retained 1MB array per round trips this leg red (the Agent Note records the red output); the committed shape is the restored, green one",
  "checker": "test/e2e/scenarios/leak-canary.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.error(`leak-canary: PASS growth=${r.heap.growthBytes}B (before=${r.heap.beforeMemoryUsedSize} after=${r.heap.afterMemoryUsedSize} tolerance=${r.heap.toleranceBytes})`);
' "$ART_DIR/receipt.json" >&2
