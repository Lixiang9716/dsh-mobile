#!/bin/sh
# runtime/dsh/ci/run-seam-inventory-e2e.sh — the CLI proof run for the
# capability-seams comparison (docs/plugin-dev.md): boots the
# production-equivalent mobile spine (every product flag + the composition
# plane), walks the cordis registry, and probes every upstream-catalog
# service name through the resolver. The present/absent split is the
# runtime's own answer to "which seams exist on mobile".
#
# Artifacts: runtime/dsh/artifacts/macos-cli-seam-inventory/.
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

ART_DIR="$ROOT/runtime/dsh/artifacts/macos-cli-seam-inventory"
MOCK_KEY="mock-key-0001"
WAIT_DEADLINE_SECONDS=15

sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh > /dev/null
[ -x build/dsh-cli ] || sh host/build.sh

LLM_LOG="$(mktemp /tmp/dsh-mock-llm-seams.XXXXXX)"
node ci/mock-llm-server.mjs > "$LLM_LOG" 2>&1 &
LLM_PID=$!
cleanup() {
    kill "$LLM_PID" 2>/dev/null || true
    wait "$LLM_PID" 2>/dev/null || true
    rm -f "$LLM_LOG"
}
trap cleanup EXIT INT TERM

announce() { # $1=log $2=announce-prefix
    polled=0
    until grep -s "^$2=" "$1" > /dev/null; do
        kill -0 "$LLM_PID" 2>/dev/null || {
            echo "mock server $2 died before announcing:" >&2
            cat "$1" >&2
            exit 1
        }
        polled=$((polled + 1))
        if [ "$polled" -gt $((WAIT_DEADLINE_SECONDS * 20)) ]; then
            echo "mock server did not announce $2 within ${WAIT_DEADLINE_SECONDS}s" >&2
            exit 1
        fi
        sleep 0.05
    done
}
announce "$LLM_LOG" MOCK_BASE_URL
LLM_URL="$(sed -n "s/^MOCK_BASE_URL=//p" "$LLM_LOG" | head -1)"
echo "mock llm server: $LLM_URL" >&2

./build/dsh-cli . scenario/seam-inventory.js \
    --http \
    --env "DSH_MOCK_LLM_URL=$LLM_URL" \
    --env "DSH_MOCK_LLM_KEY=$MOCK_KEY" > logs-seam-inventory.txt
mkdir -p "$ART_DIR"
cp logs-seam-inventory.txt "$ART_DIR/logs.txt"
grep '^dsh.runtime.log:' logs-seam-inventory.txt > "$ART_DIR/scenario.jsonl"
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/seam-inventory.json" \
    --log logs-seam-inventory.txt \
    --out "$ART_DIR/verdict.json"

EVENTS="$(grep -c '^dsh.runtime.log:' logs-seam-inventory.txt)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "darwin-cli (Darwin $(uname -srm))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, sha256-pinned by runtime/dsh/vendor/ensure-dsh.sh)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "seam.inventory",
  "proves": [
    "the production-equivalent mobile spine (all product flags + composition plane) boots and holds a non-empty plugin registry (seam.inventory/registry.walk)",
    "every upstream-catalog service name resolves or is answered absent through the SAME resolver inject uses — the runtime's own seam inventory (seam.inventory/inventory.proved)"
  ],
  "checker": "test/e2e/scenarios/seam-inventory.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

echo "e2e: PASS $ART_DIR" >&2
