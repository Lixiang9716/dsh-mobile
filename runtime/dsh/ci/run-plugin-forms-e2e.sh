#!/bin/sh
# runtime/dsh/ci/run-plugin-forms-e2e.sh — the CLI proof run for the
# upstream plugin tutorial's one-to-one promise (docs/plugin-dev.md): all
# three plugin forms (object / function / Service class) mount LIVE through
# the workspace chain, `inject` orders the load, `ctx.effect` cleanups run
# on unload, an edited source reloads under the epoch cache-buster, and the
# boot-list (the cordis.yml-insert equivalent) mounts exactly the enabled
# rows. Deterministic — no model, no approval dialog (the scripted leg
# passes approved: true).
#
# The captured log is verified one-to-one against
# test/e2e/scenarios/plugin-forms.json. Artifacts:
# runtime/dsh/artifacts/macos-cli-plugin-forms/.
#
# usage: run-plugin-forms-e2e.sh   (artifacts: .../macos-cli-plugin-forms)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

ART_DIR="$ROOT/runtime/dsh/artifacts/macos-cli-plugin-forms"
MOCK_KEY="mock-key-0001"
WAIT_DEADLINE_SECONDS=15

# 1. vendored upstream closure + the CLI host binary when missing.
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh > /dev/null
[ -x build/dsh-cli ] || sh host/build.sh

# 2. loopback mock LLM (the boot requires a route; no agent turn runs).
LLM_LOG="$(mktemp /tmp/dsh-mock-llm-plugin-forms.XXXXXX)"
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

# 3. run the scenario and verify the log one-to-one. The scratch workspace
#    (tmp/plugin-forms) is gitignored — the trees and the registry the leg
#    writes stay out of the tree.
./build/dsh-cli . scenario/plugin-forms.js \
    --http \
    --env "DSH_MOCK_LLM_URL=$LLM_URL" \
    --env "DSH_MOCK_LLM_KEY=$MOCK_KEY" > logs-plugin-forms.txt
mkdir -p "$ART_DIR"
cp logs-plugin-forms.txt "$ART_DIR/logs.txt"
grep '^dsh.runtime.log:' logs-plugin-forms.txt > "$ART_DIR/scenario.jsonl"
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/plugin-forms.json" \
    --log logs-plugin-forms.txt \
    --out "$ART_DIR/verdict.json"

EVENTS="$(grep -c '^dsh.runtime.log:' logs-plugin-forms.txt)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "darwin-cli (Darwin $(uname -srm))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, sha256-pinned by runtime/dsh/vendor/ensure-dsh.sh)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "plugin.forms",
  "proves": [
    "all three upstream plugin forms mount live through the workspace chain: object (name/inject/apply), function (export default), and class (extends Service from @deepseek-ai/cordis) (plugin.forms/form.mounted)",
    "the class form's static inject ['tools'] orders the load and the service answers through the cordis resolver (plugin.forms/forms.live)",
    "unload is first-class: fiber.dispose() runs the ctx.effect cleanups and the service stops resolving (plugin.forms/form.unmounted + unload.effects)",
    "an edited source reloads under the epoch cache-buster (?e=1) — the fresh compile is what runs (plugin.forms/reload.edited)",
    "the boot-list mounts exactly the ENABLED registry rows (the cordis.yml-insert equivalent); a disabled row is skipped (plugin.forms/bootlist.mounted)"
  ],
  "checker": "test/e2e/scenarios/plugin-forms.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

echo "e2e: PASS $ART_DIR" >&2
