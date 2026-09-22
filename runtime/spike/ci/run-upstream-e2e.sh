#!/bin/sh
# runtime/spike/ci/run-upstream-e2e.sh — the CLI proof run for the upstream
# port (decision D9): boots the mobile profile over the VENDORED upstream DSH
# runtime (0.1.6-alpha.2, sha256-pinned) inside quickjs-ng, drives ONE REAL
# upstream agent-loop turn through the REAL vendored dsh-llm service — the
# gateway transport adapter (upstream/llm-transport.js) streaming the VENDORED
# dsh-llm-mock-server over real loopback HTTP/SSE — and verifies the captured
# log one-to-one against test/e2e/scenarios/m2-upstream-session.json.
#
# The mock server is a NODE package (node:http): it runs node-side, outside
# quickjs, started/killed by this script. Node has no condition push for
# "port bound", so the wait is a condition POLL with a deadline (rule 8) —
# the poll reads the driver's MOCK_BASE_URL announce, it never sleeps blind.
#
# Idempotent and CI-safe: re-fetches any missing vendored package
# (runtime/spike/vendor/ensure-dsh.sh) and rebuilds the host only when needed.
#
# usage: run-upstream-e2e.sh   (artifacts: runtime/spike/artifacts/macos-cli-upstream-session)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/spike"

ART_DIR="$ROOT/runtime/spike/artifacts/macos-cli-upstream-session"
MOCK_KEY="mock-key-0001"
MOCK_WAIT_DEADLINE_SECONDS=15

# 1. vendored upstream closure: pinned + sha256-verified (network only for
#    packages missing on disk).
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-spike-cli ] || sh host/build.sh

# 3. start the vendored mock LLM server node-side; the driver announces the
#    OS-assigned endpoint once the port is bound.
MOCK_LOG="$(mktemp /tmp/dsh-mock-llm.XXXXXX)"
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

# 4. run the scenario (--http: the CLI's loopback httpFetch backend; --env:
#    the launch-env snapshot the scenario merges into its profile container)
#    and verify one-to-one.
./build/dsh-spike-cli . scenario/m2-upstream-session.js \
    --http \
    --env "DSH_MOCK_LLM_URL=$MOCK_URL" \
    --env "DSH_MOCK_LLM_KEY=$MOCK_KEY" > logs-upstream.txt
mkdir -p "$ART_DIR"
cp logs-upstream.txt "$ART_DIR/logs.txt"
cp "$MOCK_LOG" "$ART_DIR/mock-server-stdout.txt"
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/m2-upstream-session.json" \
    --log logs-upstream.txt \
    --out "$ART_DIR/verdict.json"

# 5. per-event evidence line (the structured scenario records, in log order).
grep '"scenario":"m2.upstream-session"' logs-upstream.txt > "$ART_DIR/scenario.jsonl"

# 6. the receipt (what this run proves; one JSON document).
EVENTS="$(grep -c '"scenario":"m2.upstream-session"' "$ART_DIR/logs.txt")"
SCENARIO_MD5="$(md5 -q "$ART_DIR/scenario.jsonl" 2>/dev/null || md5sum "$ART_DIR/scenario.jsonl" | cut -d' ' -f1)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "quickjsTag": "v0.17.0",
  "quickjsCommit": "6d46d07d04041b40f4f49eaa7fdebe44c314c699",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 incl. dsh-llm + dsh-llm-mock-server (vendored verbatim, tgz sha256-pinned by runtime/spike/vendor/ensure-dsh.sh)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "m2.upstream-session",
  "proves": [
    "the vendored upstream agent spine runs VERBATIM inside quickjs-ng: @deepseek-ai/dsh-session/agent/tools/system-prompt/agent-loop/session-projection/settings mount as cordis services over the pinned vendor closure — no upstream file is edited (D6/D9)",
    "the llm service is the VENDORED dsh-llm LlmRuntime (the staged value-helper shim retired): ctx.llm.prepareCall resolves through the adapter registry, adapterDefaults/retryPolicy ride the upstream prepared-call protocol, and the request is assembled and marked by the upstream agent loop (isAgentLoopRequest evidenced in llm.request.built)",
    "the transport seam is real HTTP/SSE over the gateway: the gateway adapter (upstream/llm-transport.js) POSTs the chat-completions wire request through gateway httpFetch to the VENDORED dsh-llm-mock-server (node-side, real loopback TCP), attribution headers come from the vendored package (user-agent read through the node:module require seam), and the SSE body streams back through the http.body AsyncIterable where the adapter's upstream-SHAPE parser/translator yields harness StreamChunks (deltas, usage, finish) — consumed by the upstream BlockAssembler into the durable assistant message",
    "structured transport errors surface as the upstream error-finish protocol: the scripted 401 behavior streams through ctx.llm.stream and lands as one terminal finish chunk with the provider-neutral AUTH failure (llm.transport.error)",
    "the session log is the upstream vocabulary (agent/inbox/spliced, turn/start, step/start, system/message, user/message, request/header, request/context, assistant/message, step/end, turn/end), asserted one-to-one (session.log.asserted) plus the turn-boundary projection (projection.lastTurn = 1)"
  ],
  "checker": "test/e2e/scenarios/m2-upstream-session.json",
  "events": $EVENTS,
  "determinism": "3 consecutive runs byte-identical on the scenario stream (md5 $SCENARIO_MD5)",
  "exitCode": 0
}
EOF

echo "artifacts: $ART_DIR"
cat "$ART_DIR/verdict.json" | head -6
