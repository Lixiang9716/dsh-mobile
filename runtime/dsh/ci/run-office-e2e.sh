#!/bin/sh
# runtime/dsh/ci/run-office-e2e.sh — the CLI proof run for the dsh-office
# system plugin (the ported dsh-office-tools surface: word/excel/ppt view +
# authoring over vendored fflate and the gateway fs primitives): boots the
# mobile profile exactly as upstream.session does, then drives all eight
# tools through the REAL ToolRuntime dispatch — create/read/update
# round-trips for .docx and .xlsx, create/read for .pptx, the REAL-library
# fixture legs (python-docx / openpyxl / python-pptx bytes committed as
# base64 in scenario/office-fixtures.js), and the no-overwrite refusal.
#
# The captured log is verified one-to-one against
# test/e2e/scenarios/office.json. Artifacts:
# runtime/dsh/artifacts/macos-cli-office/.
#
# usage: run-office-e2e.sh   (artifacts: .../macos-cli-office)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

ART_DIR="$ROOT/runtime/dsh/artifacts/macos-cli-office"
MOCK_KEY="mock-key-0001"
WAIT_DEADLINE_SECONDS=15

# 1. vendored upstream closure: pinned + sha256-verified (fflate rides the
#    same pin table — the office zip engine).
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh > /dev/null

# 2. build the spike host when the binary is missing.
[ -x build/dsh-cli ] || sh host/build.sh

# 3. loopback mock LLM (the boot requires a route; no agent turn runs),
#    condition-polled (rule 8) for its announce.
LLM_LOG="$(mktemp /tmp/dsh-mock-llm-office.XXXXXX)"
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

# 4. run the scenario (--http: loopback httpFetch; --env: the launch env
#    snapshot carrying the llm route) and verify the log one-to-one.
./build/dsh-cli . scenario/office.js \
    --http \
    --env "DSH_MOCK_LLM_URL=$LLM_URL" \
    --env "DSH_MOCK_LLM_KEY=$MOCK_KEY" > logs-office.txt
mkdir -p "$ART_DIR"
cp logs-office.txt "$ART_DIR/logs.txt"
grep '^dsh.spike.log:' logs-office.txt > "$ART_DIR/scenario.jsonl"
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/office.json" \
    --log logs-office.txt \
    --out "$ART_DIR/verdict.json"

EVENTS="$(grep -c '^dsh.spike.log:' logs-office.txt)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "darwin-cli (Darwin $(uname -srm))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, sha256-pinned by runtime/dsh/vendor/ensure-dsh.sh)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "office",
  "proves": [
    "the dsh-office system plugin mounts with the spine and offers all eight tools (office/offered) — word_create/word_read/word_update, excel_create/excel_read/excel_update, ppt_create/ppt_read",
    "the Word legs round-trip: create (title/paragraphs/bullets/table) → markdown read (headings, bullets, pipe table) → append → the appended paragraph reads back (office.word/*)",
    "the Excel legs round-trip: grid + formula create → scalar read-back → an A1 cell update lands (office.excel/*)",
    "the PowerPoint legs round-trip: widescreen deck with title slide, bullets and speaker notes → the read-back sees every paragraph and the layout elements (office.ppt/*)",
    "the view legs read REAL-library files: python-docx / openpyxl / python-pptx fixtures (committed base64) written into the workspace and read by word_read / excel_read / ppt_read (office.fixture/*)",
    "word_create refuses an existing path without overwrite: true (office.negative/refused)"
  ],
  "checker": "test/e2e/scenarios/office.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

echo "e2e: PASS $ART_DIR" >&2
