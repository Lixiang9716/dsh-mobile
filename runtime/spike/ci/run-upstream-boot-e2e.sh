#!/bin/sh
# runtime/spike/ci/run-upstream-boot-e2e.sh — the CLI proof run for the
# OFFICIAL WEB BOOT over the vendored runtime (decision D9, W-INTEG leg):
# boots the mobile profile exactly as upstream.session does, streams ONE
# REAL agent-loop turn through the vendored dsh-llm (so the session journal
# carries real records), then mounts the VENDORED @deepseek-ai/dsh-client-
# modules node half over the staged `web.plugins` delivery and lets IT compose
# the official web boot wire (facade queue + combo batches + __DSH_BOOT__).
# The runtime posts web.boot + api.claim + mux.claim over the bus seam — the
# exact frames the platform carrier consumes — and the scenario self-probes
# the claimed surface: session.list from the REAL session store, a
# session/journal mux stream (baseline + live change frames + cancel).
#
# The captured log is verified one-to-one against
# test/e2e/scenarios/upstream-web-boot.json. Artifacts:
# runtime/spike/artifacts/macos-cli-upstream-boot/.
#
# The mock server script is widened for this drive (two success turns) via
# DSH_MOCK_SEQUENCE/DSH_MOCK_REPEAT_LAST; defaults keep the m2 script intact.
#
# usage: run-upstream-boot-e2e.sh   (artifacts: .../macos-cli-upstream-boot)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/spike"

ART_DIR="$ROOT/runtime/spike/artifacts/macos-cli-upstream-boot"
MOCK_KEY="mock-key-0001"
MOCK_WAIT_DEADLINE_SECONDS=15

# 1. vendored upstream closure: pinned + sha256-verified (incl. the
#    @deepseek-ai/dsh-client-modules package the web-boot leg vendors).
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-spike-cli ] || sh host/build.sh

# 3. stage the web.plugins bus payload from the vendored client-modules tree
#    (package.json + lib/client.js; fixed generation stamp, see the script).
PAYLOAD="$(mktemp /tmp/dsh-web-plugins.XXXXXX)"
node ci/web-plugins-payload.mjs "$PAYLOAD"

# 4. start the mock LLM server with THREE scripted successes (two streamed
#    turns; the third guards a retry) and wait for the endpoint announce
#    (condition poll with a deadline, rule 8).
MOCK_LOG="$(mktemp /tmp/dsh-mock-llm-boot.XXXXXX)"
DSH_MOCK_SEQUENCE="success success success" DSH_MOCK_REPEAT_LAST=1 \
    node ci/mock-llm-server.mjs > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() {
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
    rm -f "$MOCK_LOG" "$PAYLOAD"
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

# 5. run the scenario (--http: loopback httpFetch; --bus-inject: the staged
#    web.plugins delivery; --env: the launch env snapshot) and verify.
./build/dsh-spike-cli . scenario/upstream-web-boot.js \
    --http \
    --bus-inject "$PAYLOAD" \
    --env "DSH_MOCK_LLM_URL=$MOCK_URL" \
    --env "DSH_MOCK_LLM_KEY=$MOCK_KEY" > logs-upstream-boot.txt
mkdir -p "$ART_DIR"
cp logs-upstream-boot.txt "$ART_DIR/logs.txt"
grep '^dsh.spike.log:' logs-upstream-boot.txt > "$ART_DIR/scenario.jsonl"
cp "$MOCK_LOG" "$ART_DIR/mock-server-stdout.txt"
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/upstream-web-boot.json" \
    --log logs-upstream-boot.txt \
    --out "$ART_DIR/verdict.json"

EVENTS="$(grep -c '^dsh.spike.log:' logs-upstream-boot.txt)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "darwin-cli (Darwin $(uname -srm))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "quickjsTag": "v0.17.0",
  "quickjsCommit": "6d46d07d04041b40f4f49eaa7fdebe44c314c699",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 incl. dsh-client-modules (vendored verbatim, tgz sha256-pinned by runtime/spike/vendor/ensure-dsh.sh) + the W-SHELL application tier (presentation/official-web/client-bundles, MANIFEST.sha256-verified)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "upstream.web-boot",
  "proves": [
    "the OFFICIAL web boot wire is composed INSIDE the runtime by the vendored @deepseek-ai/dsh-client-modules node half over the full application-tier staging: 58 dsh.client entries, the bootstrap batch exactly [@deepseek-ai/dsh-client-modules], the application batches over the other 57, external-dependency rows ordered before their consumers (web/boot/composed)",
    "the injected rows carry the facade queue script, the application script-preload, the bootstrap script-src, and the graph global last (web/boot/rows); the vendored parseBootManifest cross-parses the composed graph (parseOk)",
    "the /api + mux claims answer from the REAL vendored services: session.list from the session store, the session/journal stream in the Remote-journal envelope (baseline + live change frames + cancel)"
  ],
  "checker": "test/e2e/scenarios/upstream-web-boot.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

# 6. per-event evidence line (the structured scenario records, in log order).
echo "e2e: PASS $ART_DIR" >&2
