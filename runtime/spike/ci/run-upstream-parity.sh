#!/bin/sh
# run-upstream-parity.sh — the UPSTREAM PARITY differential: the vendored
# upstream DSH spine runs TWICE over the same scripted turns — once under
# plain Node (the host upstream itself targets, ci/parity-reference.mjs) and
# once inside quickjs through the real mobile profile boot
# (scenario/upstream-parity.js) — and the two authoritative session logs,
# normalized by the SHARED projector (scenario/parity-projector.js), must be
# identical record for record (ci/parity-compare.mjs fails loud at the first
# divergence).
#
# The scripted wire (the VENDORED dsh-llm-mock-server, node-side): a success
# turn, a TOOL-CALL round (todo_write with schema-valid arguments, dispatched
# through the real ToolRuntime, its result feeding the next step), the
# closing success, and the 401 transport-error leg.
#
# The committed golden (test/e2e/fixtures/upstream-parity-reference.jsonl) is
# what every port leg compares against: a live run must REPRODUCE the
# reference byte-for-byte; refresh it deliberately with --update-golden after
# a reviewed change. --reference-only stops after the reference half (Linux
# hosts cannot link the vendored iSH-arm64 engine into the CLI binary, so
# the quickjs port leg runs on macOS CI here, or on the Android emulator via
# hosts/android/ci/run-upstream-parity.sh).
#
# usage: run-upstream-parity.sh [--update-golden] [--reference-only]
#        (artifacts: runtime/spike/artifacts/macos-cli-upstream-parity)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/spike"

ART_DIR="$ROOT/runtime/spike/artifacts/macos-cli-upstream-parity"
GOLDEN="$ROOT/test/e2e/fixtures/upstream-parity-reference.jsonl"
MOCK_KEY="mock-key-0001"
MOCK_WAIT_DEADLINE_SECONDS=15
UPDATE_GOLDEN=0
REFERENCE_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --update-golden) UPDATE_GOLDEN=1 ;;
        --reference-only) REFERENCE_ONLY=1 ;;
        *) echo "usage: run-upstream-parity.sh [--update-golden] [--reference-only]" >&2; exit 2 ;;
    esac
done

# 1. vendored upstream closure + the Node resolution layout for the reference.
#    (ensure-ish: the C host links the vendored iSH engine even though this
#    scenario never runs it — a fresh macOS tree needs the sources to build.)
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh
sh vendor/ensure-ish.sh
sh ci/parity-node-modules.sh

# 2. the mock LLM server (node-side) with the parity script: success,
#    tool_call_success (todo_write), closing success, 401.
MOCK_LOG="$(mktemp /tmp/dsh-mock-parity.XXXXXX)"
DSH_MOCK_SEQUENCE='success tool_call_success success auth_error' \
DSH_MOCK_TOOL_NAME='todo_write' \
DSH_MOCK_TOOL_ARGS='{"todos":[{"content":"Track the parity check","status":"in_progress"}]}' \
    node ci/mock-llm-server.mjs > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() {
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
    rm -f "$MOCK_LOG"
}
trap cleanup EXIT INT TERM

MOCK_URL=""
polled=0
until grep -s '^MOCK_BASE_URL=' "$MOCK_LOG" > /dev/null; do
    if ! kill -0 "$MOCK_PID" 2>/dev/null; then
        echo "mock llm server died before announcing its endpoint:" >&2
        cat "$MOCK_LOG" >&2
        exit 1
    fi
    polled=$((polled + 1))
    if [ "$polled" -gt $((MOCK_WAIT_DEADLINE_SECONDS * 20)) ]; then
        echo "mock llm server did not announce within ${MOCK_WAIT_DEADLINE_SECONDS}s" >&2
        exit 1
    fi
    sleep 0.05
done
MOCK_URL="$(sed -n 's/^MOCK_BASE_URL=//p' "$MOCK_LOG" | head -1)"
echo "mock llm server: $MOCK_URL" >&2

mkdir -p "$ART_DIR"

# 3. the REFERENCE leg: the same vendored spine under plain Node.
DSH_MOCK_LLM_URL="$MOCK_URL" DSH_MOCK_LLM_KEY="$MOCK_KEY" \
    node ci/parity-reference.mjs > "$ART_DIR/reference-stdout.txt"
grep '^PARITY_EVENT ' "$ART_DIR/reference-stdout.txt" | sed 's/^PARITY_EVENT //' > "$ART_DIR/reference.jsonl"
grep '^PARITY_SUMMARY ' "$ART_DIR/reference-stdout.txt" | sed 's/^PARITY_SUMMARY //' > "$ART_DIR/reference-summary.json"
grep '^PARITY_ERROR_LEG ' "$ART_DIR/reference-stdout.txt" | sed 's/^PARITY_ERROR_LEG //' > "$ART_DIR/reference-error-leg.json"
[ -s "$ART_DIR/reference.jsonl" ] || { echo "reference leg produced no PARITY_EVENT lines" >&2; exit 1; }

# 4. the golden discipline: the live reference must reproduce the committed
#    golden byte-for-byte (every port leg diffs against the golden).
if [ "$UPDATE_GOLDEN" = "1" ]; then
    mkdir -p "$(dirname "$GOLDEN")"
    cp "$ART_DIR/reference.jsonl" "$GOLDEN"
    echo "golden refreshed: $GOLDEN" >&2
elif [ ! -f "$GOLDEN" ]; then
    echo "::error::parity golden missing ($GOLDEN) — run once with --update-golden and review the diff" >&2
    exit 1
elif ! cmp -s "$ART_DIR/reference.jsonl" "$GOLDEN"; then
    echo "::error::live reference diverged from the committed golden — refresh deliberately (--update-golden) after review" >&2
    diff "$GOLDEN" "$ART_DIR/reference.jsonl" | head -20 >&2 || true
    exit 1
fi

if [ "$REFERENCE_ONLY" = "1" ]; then
    echo "reference-only mode: golden verified/refreshed, port leg skipped" >&2
    exit 0
fi

# 5. the PORT leg: the same scripted turns inside quickjs (needs the CLI
#    binary; built here on macOS, never on Linux — the vendored iSH-arm64
#    engine does not assemble under x86-64).
[ -x build/dsh-spike-cli ] || sh host/build.sh
./build/dsh-spike-cli . scenario/upstream-parity.js \
    --http \
    --env "DSH_MOCK_LLM_URL=$MOCK_URL" \
    --env "DSH_MOCK_LLM_KEY=$MOCK_KEY" > logs-parity.txt
cp logs-parity.txt "$ART_DIR/logs.txt"
cp "$MOCK_LOG" "$ART_DIR/mock-server-stdout.txt"

# 6. extract the port leg's projected records from the scenario stream.
node - "$ART_DIR" logs-parity.txt <<'EXTRACT'
const fs = require('fs');
const art = process.argv[2], logPath = process.argv[3];
const out = [];
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  const at = line.indexOf('{');
  if (at < 0 || !line.includes('"scenario":"upstream.parity"')) continue;
  let record;
  try { record = JSON.parse(line.slice(at)); } catch { continue; }
  const e2e = (record.data ?? [])[0];
  if (e2e?.event === 'parity/event' && e2e.record !== undefined) out.push(e2e.record);
}
fs.writeFileSync(`${art}/port.jsonl`, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
if (out.length === 0) { console.error('port leg produced no parity/event records'); process.exit(1); }
EXTRACT

# 7. the differential verdict: record-for-record identity.
node ci/parity-compare.mjs "$ART_DIR/reference.jsonl" "$ART_DIR/port.jsonl" \
    | tee "$ART_DIR/parity-verdict.txt"

# 8. the one-to-one scenario verdict (the port leg's own expected log).
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/upstream-parity.json" \
    --log logs-parity.txt \
    --out "$ART_DIR/verdict.json"

# 9. the receipt (what this run proves).
EVENTS="$(grep -c '"scenario":"upstream.parity"' "$ART_DIR/logs.txt")"
REF_COUNT="$(wc -l < "$ART_DIR/reference.jsonl" | tr -d ' ')"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "quickjs-ng + node $(node --version) (reference)",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, sha256-pinned; the SAME closure serves both legs)",
  "scenario": "upstream.parity",
  "proves": [
    "the vendored upstream spine (session/agent/system-prompt/tools/session-projection/settings/tool-todo/agent-loop/llm) produces the SAME session log under plain Node and inside quickjs through the mobile profile boot — the SHARED projector (scenario/parity-projector.js) normalized both, the comparator demanded record-for-record identity",
    "the tool round is real on both legs: the mock's scripted todo_write tool-call streams through the same gateway transport adapter code (upstream/llm-transport.js imported VERBATIM by the reference via ci/parity-node-hooks.mjs), the upstream ToolRuntime dispatches it, the result feeds the next step, and the todos projection lands identically",
    "the 401 transport-error leg surfaces as the same upstream error-finish on both legs",
    "the golden fixture (test/e2e/fixtures/upstream-parity-reference.jsonl) reproduced byte-for-byte by the live reference"
  ],
  "checker": "test/e2e/scenarios/upstream-parity.json + ci/parity-compare.mjs",
  "events": $EVENTS,
  "referenceRecords": $REF_COUNT,
  "exitCode": 0
}
EOF

echo "artifacts: $ART_DIR"
cat "$ART_DIR/verdict.json" | head -6
