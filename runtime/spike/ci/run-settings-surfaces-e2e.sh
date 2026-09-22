#!/bin/sh
# runtime/spike/ci/run-settings-surfaces-e2e.sh — the CLI proof run for the
# official client's SETTINGS screens (the 预设 roster + the 插件 inventory):
# boots the mobile profile with the REAL settings plane (the cordis Loader
# service + the vendored @deepseek-ai/dsh-agent-presets over the staged
# presets VFS), composes the official web boot wire over the FULL application
# tier (web-plugins-payload.mjs, the same staging the platform drives
# deliver), seeds the presets tree as an `agentPresets.seed` bus delivery,
# and self-probes the claimed /api surface: agentPresets/list + /read +
# /copy (the honest read-only refusal), pluginInventory/list (the honest
# read-only snapshot: mounted spine + staged client bundles + 预设
# compositions), and pluginManager/listBundles (the structured unimplemented
# — the write machinery stays unclaimed).
#
# No mock LLM server: the settings surfaces are pure reads (the scenario's
# llm route is a never-dialed placeholder).
#
# The captured log is verified one-to-one against
# tools/e2e/scenarios/settings-surfaces-cli.json. Artifacts:
# runtime/spike/artifacts/macos-cli-settings-surfaces/.
#
# usage: run-settings-surfaces-e2e.sh   (artifacts: .../macos-cli-settings-surfaces)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/spike"

ART_DIR="$ROOT/runtime/spike/artifacts/macos-cli-settings-surfaces"

# 1. vendored upstream closure: pinned + sha256-verified (incl. the
#    @deepseek-ai/dsh-client-modules package and the agent-presets closure
#    the settings plane mounts).
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-spike-cli ] || sh host/build.sh

# 3. stage the web.plugins bus payload from the full application tier
#    (package.json + lib/client.js per package; fixed generation stamp).
PAYLOAD="$(mktemp /tmp/dsh-web-plugins.XXXXXX)"
node ci/web-plugins-payload.mjs "$PAYLOAD"

cleanup() {
    rm -f "$PAYLOAD"
}
trap cleanup EXIT INT TERM

# 4. run the scenario (--bus-inject: the staged web.plugins delivery; --env:
#    the never-dialed llm placeholder the boot demands) and verify one-to-one.
./build/dsh-spike-cli . scenario/settings-surfaces-cli.js \
    --bus-inject "$PAYLOAD" \
    --env "DSH_SETTINGS_LLM_BASEURL=http://127.0.0.1:1" > logs-settings-surfaces.txt
mkdir -p "$ART_DIR"
cp logs-settings-surfaces.txt "$ART_DIR/logs.txt"
grep '^dsh.spike.log:' logs-settings-surfaces.txt > "$ART_DIR/scenario.jsonl"
node "$ROOT/tools/e2e/check.mjs" \
    --manifest "$ROOT/tools/e2e/scenarios/settings-surfaces-cli.json" \
    --log logs-settings-surfaces.txt \
    --out "$ART_DIR/verdict.json"

# 5. the receipt (what this run proves; one JSON document).
EVENTS="$(grep -c '"scenario":"settings.surfaces.cli"' logs-settings-surfaces.txt)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "quickjsTag": "v0.17.0",
  "quickjsCommit": "6d46d07d04041b40f4f49eaa7fdebe44c314c699",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 incl. dsh-client-modules + dsh-agent-presets (vendored verbatim, tgz sha256-pinned by runtime/spike/vendor/ensure-dsh.sh) + the W-SHELL application tier (presentation/official-web/client-bundles)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "settings.surfaces.cli",
  "proves": [
    "the official client's Agent 预设 screen loads real data: the REAL vendored AgentPresets service (mounted on the mobile spine with the cordis Loader service) answers agentPresets/list with the shipped roster (cordis/minimal/ptc/standard), the deployment default marked, and honest per-preset health verdicts over the staged presets VFS",
    "agentPresets/read answers the default preset's composition document from the staged presets tree, and agentPresets/copy refuses with the upstream agent-preset/read-only RemoteError (the staged fs has no user root — authoring is refused, never faked)",
    "the official client's 插件 screen renders its list instead of the error state: pluginInventory/list answers the honest read-only snapshot — the mounted runtime spine (every row read from the live context) + the staged client bundles (the composed boot roster) + the 预设 compositions, with managementAvailable false",
    "the plugin-manager write machinery stays UNCLAIMED: pluginManager/listBundles answers the runtime's structured gateway/unimplemented — fail loud, never a fake",
    "ONE cordis Loader service serves both the presets inject and the web-boot client composition's entries()/internal.resolveSync face — the unification that lets the presets mount ship without breaking the proven web.plugins path"
  ],
  "checker": "tools/e2e/scenarios/settings-surfaces-cli.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

echo "e2e: PASS $ART_DIR" >&2
