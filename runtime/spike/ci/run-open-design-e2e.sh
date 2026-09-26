#!/bin/sh
# runtime/spike/ci/run-open-design-e2e.sh — the CLI proof run for the
# dsh-open-design system plugin (the Open Design daemon client over gateway
# httpFetch): boots the mobile profile exactly as upstream.session does with
# the launch env carrying the daemon route, then drives the three tools
# through the REAL ToolRuntime dispatch against the loopback mock daemon
# (projects create/list/get/save_file, the BYOK SSE generate leg, artifact
# save + lint, and the unknown-verb refusal).
#
# The captured log is verified one-to-one against
# test/e2e/scenarios/open-design.json. Artifacts:
# runtime/spike/artifacts/macos-cli-open-design/.
#
# usage: run-open-design-e2e.sh   (artifacts: .../macos-cli-open-design)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/spike"

ART_DIR="$ROOT/runtime/spike/artifacts/macos-cli-open-design"
MOCK_KEY="mock-key-0001"
WAIT_DEADLINE_SECONDS=15

# 1. vendored upstream closure: pinned + sha256-verified.
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh > /dev/null

# 2. build the spike host when the binary is missing.
[ -x build/dsh-spike-cli ] || sh host/build.sh

# 3. start both loopback mocks (the LLM route the boot requires is never
#    driven — no agent turn runs here — and the Open Design daemon mock
#    answers the plugin's ten-endpoint subset), waiting (condition-polled,
#    rule 8) for each endpoint announce.
LLM_LOG="$(mktemp /tmp/dsh-mock-llm-od.XXXXXX)"
OD_LOG="$(mktemp /tmp/dsh-mock-od.XXXXXX)"
node ci/mock-llm-server.mjs > "$LLM_LOG" 2>&1 &
LLM_PID=$!
node ci/mock-open-design-server.mjs > "$OD_LOG" 2>&1 &
OD_PID=$!
cleanup() {
    kill "$LLM_PID" "$OD_PID" 2>/dev/null || true
    wait "$LLM_PID" "$OD_PID" 2>/dev/null || true
    rm -f "$LLM_LOG" "$OD_LOG"
}
trap cleanup EXIT INT TERM

announce() { # $1=log $2=announce-prefix $3=deadline-s
    polled=0
    until grep -s "^$2=" "$1" > /dev/null; do
        kill -0 "$3" 2>/dev/null || {
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
announce "$LLM_LOG" MOCK_BASE_URL "$LLM_PID"
announce "$OD_LOG" OD_MOCK_BASE_URL "$OD_PID"
LLM_URL="$(sed -n "s/^MOCK_BASE_URL=//p" "$LLM_LOG" | head -1)"
OD_URL="$(sed -n "s/^OD_MOCK_BASE_URL=//p" "$OD_LOG" | head -1)"
echo "mock llm server: $LLM_URL" >&2
echo "mock open-design daemon: $OD_URL" >&2

# 4. run the scenario (--http: loopback httpFetch; --env: the launch env
#    snapshot that carries BOTH the llm route and the daemon + BYOK config)
#    and verify the log one-to-one.
./build/dsh-spike-cli . scenario/open-design.js \
    --http \
    --env "DSH_MOCK_LLM_URL=$LLM_URL" \
    --env "DSH_MOCK_LLM_KEY=$MOCK_KEY" \
    --env "DSH_OPEN_DESIGN_URL=$OD_URL" \
    --env "DSH_OPEN_DESIGN_BYOK_BASE_URL=http://127.0.0.1:9/v1" \
    --env "DSH_OPEN_DESIGN_BYOK_API_KEY=byok-key-0001" \
    --env "DSH_OPEN_DESIGN_BYOK_MODEL=mock-designer-1" > logs-open-design.txt
mkdir -p "$ART_DIR"
cp logs-open-design.txt "$ART_DIR/logs.txt"
grep '^dsh.spike.log:' logs-open-design.txt > "$ART_DIR/scenario.jsonl"
cp "$OD_LOG" "$ART_DIR/mock-daemon-stdout.txt"
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/open-design.json" \
    --log logs-open-design.txt \
    --out "$ART_DIR/verdict.json"

EVENTS="$(grep -c '^dsh.spike.log:' logs-open-design.txt)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "darwin-cli (Darwin $(uname -srm))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, sha256-pinned by runtime/spike/vendor/ensure-dsh.sh)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "open.design",
  "proves": [
    "the dsh-open-design system plugin mounts with the spine and offers its three tools when the launch env configures a daemon (od/offered)",
    "the project legs round-trip the daemon's REST surface through gateway httpFetch: create/list/get/save_file (od.project/*)",
    "the BYOK generate leg streams the artifact through the daemon's SSE proxy and reassembles it intact — the OD-MOCK-77f3 marker and the byte count come back (od.generate/completed)",
    "artifact save returns the shareable url/path and lint returns the daemon's findings (od.artifact/*); an unknown verb refuses naming the valid verbs (od.verb/refused)"
  ],
  "checker": "test/e2e/scenarios/open-design.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

echo "e2e: PASS $ART_DIR" >&2
