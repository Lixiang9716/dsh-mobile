#!/bin/sh
# runtime/spike/ci/run-models-directory-e2e.sh — the CLI proof run for the
# official client's models 设置页: boots the mobile profile with the route
# provider staged (the vendored LlmRuntime directory registering exactly
# that route), creates the write surface with `fullCoverage: true` (the
# llm directory + credential write half claimed as the coverage plane claims
# them on device), and self-probes the claimed /api surface:
# llm/listProviders + llm/listConfigurableProviders (the DECLARED provider
# row), settings/canOpenAgentPresetDirectory (the read-only gate),
# settings/describe (the llm-<provider> mirror with the STAGED ROUTE as its
# base layer), settings/mutate (the page write landing in the user layer
# over the intact base), the credentials set→describe→unset→describe
# round-trip, and session/modelCatalog.
#
# No mock LLM server: the models page is configuration surface (the llm
# route is a never-dialed placeholder). The runner greps the RAW log for
# both the staged key and the round-trip secret — neither may appear.
#
# The captured log is verified one-to-one against
# test/e2e/scenarios/models-directory.json. Artifacts:
# runtime/spike/artifacts/macos-cli-models-directory/.
#
# usage: run-models-directory-e2e.sh   (artifacts: .../macos-cli-models-directory)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/spike"

ART_DIR="$ROOT/runtime/spike/artifacts/macos-cli-models-directory"

# 1. vendored upstream closure: pinned + sha256-verified.
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-spike-cli ] || sh host/build.sh

# 3. run the scenario and verify one-to-one.
./build/dsh-spike-cli . scenario/models-directory.js > logs-models-directory.txt
mkdir -p "$ART_DIR"
cp logs-models-directory.txt "$ART_DIR/logs.txt"
grep '^dsh.spike.log:' logs-models-directory.txt > "$ART_DIR/scenario.jsonl"
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/models-directory.json" \
    --log logs-models-directory.txt \
    --out "$ART_DIR/verdict.json"

# 4. the key audit: the staged credential and the round-trip secret appear
#    nowhere in the raw capture (the llm-live-stream runner's rule).
if grep -F -e 'staged-model-key' -e 'sekrit-page-key' logs-models-directory.txt >/dev/null; then
    echo "e2e: FAIL — a credential value leaked into the log" >&2
    exit 1
fi

# 5. the receipt (what this run proves; one JSON document).
EVENTS="$(grep -c '"scenario":"models.directory"' logs-models-directory.txt)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "quickjsTag": "v0.17.0",
  "quickjsCommit": "6d46d07d04041b40f4f49eaa7fdebe44c314c699",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, tgz sha256-pinned by runtime/spike/vendor/ensure-dsh.sh)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "models.directory",
  "proves": [
    "the official client's models 设置页 renders its provider row instead of an empty list: llm/listProviders answers the single route provider and llm/listConfigurableProviders answers the DECLARED row (provider mock, settingsNs llm-mock, settingsPath providers/default) off the boot-registered vendored LlmRuntime directory — the e230ce1 contract",
    "settings/canOpenAgentPresetDirectory answers false: the models page stays read-only on this host, honestly",
    "the settings mirror the row renders from is real: settings/describe answers the llm-mock namespace with the STAGED ROUTE as its base layer (baseURL/model/apiKeyEnv) and a free user layer; settings/mutate lands a page write in the user layer over the intact base with revision +1",
    "the credential state behind the row's 已配置 badge round-trips: credentials/set → describe (configured, source never answers) → unset → describe (cleared); the staged key and the round-trip secret appear nowhere in the raw log",
    "session/modelCatalog answers the staged single-route catalog (default mock/probe-1, one group, one model) — the model picker's data, nothing invented"
  ],
  "checker": "test/e2e/scenarios/models-directory.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

echo "e2e: PASS $ART_DIR" >&2
