#!/bin/sh
# runtime/spike/ci/run-onboarding-e2e.sh — the CLI proof run for the BYOK
# first-run onboarding panel (scenario `onboarding.flow`): boots the mobile
# profile with the mock route (no usable credential — a beta user's first
# launch), creates the write surface with `fullCoverage: true` (the
# onboarding legs claimed exactly as the coverage plane claims them on
# device), and walks the page's flow at the same wire boundary the page
# uses: onboarding/status (无凭证 detect), the onboarding/test stream's two
# paths against the vendored mock LLM server (the scripted success over the
# REAL gateway httpFetch transport, and the 401 auth leg → one readable
# error), onboarding/save (keychain persist + live rebind), the models
# 设置页 directory following the live route (the byok row), the re-detect
# (已配过), the RELAUNCH route resolution (boot #2 reads the keychain through
# upstream/llm-route.js), the FIRST TURN over the rebound route through the
# page's own wire (session/create → session/prompt → the scripted assistant
# text), and onboarding/CLEAR (the keychain delete + the LIVE boot-route
# restore — the second turn answers from the restored mock adapter, no
# relaunch).
#
# The mock server is a NODE package (node:http): it runs node-side, outside
# quickjs, started/killed by this script (condition-polled announce, rule 8).
# Script positions are consumed only by AUTH-PASSED requests (the mock's own
# bearer check runs before the script dispatch): probe 1 takes position 1
# (success), the wrong-key probe NEVER reaches the script (the mock's
# unconditional auth rejection IS the failure leg — a real 401, no script
# needed), the first turn takes position 2 (success), and the post-clear
# second turn takes position 3 (success — the restored adapter's proof).
#
# The captured log is verified one-to-one against
# test/e2e/scenarios/onboarding-flow.json. Artifacts:
# runtime/spike/artifacts/macos-cli-onboarding/.
#
# The key audit: the mock key (the saved credential's value) and the
# wrong-key probe value appear nowhere in the raw log.
#
# usage: run-onboarding-e2e.sh   (artifacts: .../macos-cli-onboarding)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/spike"

ART_DIR="$ROOT/runtime/spike/artifacts/macos-cli-onboarding"
MOCK_KEY="mock-key-0001"
WRONG_KEY="byok-wrong-key-0000"
MOCK_WAIT_DEADLINE_SECONDS=15

# 1. vendored upstream closure: pinned + sha256-verified.
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-spike-cli ] || sh host/build.sh

# 3. start the mock LLM server with the flow's three-request script and wait
#    for the endpoint announce (condition poll with a deadline, rule 8).
MOCK_LOG="$(mktemp /tmp/dsh-mock-llm-onboarding.XXXXXX)"
DSH_MOCK_SEQUENCE="success success success" node ci/mock-llm-server.mjs \
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
        echo "e2e: FAIL — the mock LLM server died before announcing" >&2
        exit 1
    fi
    if [ "$polled" -ge $((MOCK_WAIT_DEADLINE_SECONDS * 20)) ]; then
        echo "e2e: FAIL — no MOCK_BASE_URL announce within ${MOCK_WAIT_DEADLINE_SECONDS}s" >&2
        exit 1
    fi
    sleep 0.05
    polled=$((polled + 1))
done
MOCK_URL="$(sed -n 's/^MOCK_BASE_URL=//p' "$MOCK_LOG" | head -1)"
echo "mock llm server: $MOCK_URL" >&2

# 4. run the scenario (--http: the CLI's loopback httpFetch backend — the
#    probe transport; --env: the launch-env snapshot) and verify one-to-one.
./build/dsh-spike-cli . scenario/onboarding.js \
    --http \
    --env "DSH_MOCK_LLM_URL=$MOCK_URL" \
    --env "DSH_MOCK_LLM_KEY=$MOCK_KEY" > logs-onboarding.txt
mkdir -p "$ART_DIR"
cp logs-onboarding.txt "$ART_DIR/logs.txt"
grep '^dsh.spike.log:' logs-onboarding.txt > "$ART_DIR/scenario.jsonl"
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/onboarding-flow.json" \
    --log logs-onboarding.txt \
    --out "$ART_DIR/verdict.json"

# 5. the key audit: the saved credential's value and the wrong-key probe
#    value appear nowhere in the raw capture (the models-directory rule).
if grep -F -e "$MOCK_KEY" -e "$WRONG_KEY" logs-onboarding.txt >/dev/null; then
    echo "e2e: FAIL — a credential value leaked into the log" >&2
    exit 1
fi

# 6. the receipt (what this run proves; one JSON document).
EVENTS="$(grep -c '"scenario":"onboarding.flow"' logs-onboarding.txt)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "quickjsTag": "v0.17.0",
  "quickjsCommit": "6d46d07d04041b40f4f49eaa7fdebe44c314c699",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, tgz sha256-pinned by runtime/spike/vendor/ensure-dsh.sh)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "onboarding.flow",
  "proves": [
    "the first-launch detect is honest: onboarding/status answers mode=mock (no usable credential) and the panel's show gate is exactly that shape — a configured user (byok or staged) goes straight in",
    "the connection test streams the REAL transport: one minimal chat-completions through streamChat over the gateway httpFetch primitive, scripted success streamed open→delta→done, and the wrong key answered by the mock's 401 auth leg as one readable wire error",
    "the save persists into the KEYCHAIN (contract v1.0.0 rows 8-9) — never a plaintext file, never a log line; the CLI dev host stores it as one 0600 file per ref under the smoke tmpdir (the same trust domain as its fs scopes; real hosts back the identical shapes with SecItem/Keystore)",
    "save rebinds the live route through the vendored registry (the boot adapter's disposer → the user's adapter) and mutates the surface route, so NEW sessions route to the user's endpoint; the status answer stays key-free",
    "the models 设置页 directory follows the live route: after a save the DECLARED row is the byok provider (llm-deepseek) and the settings mirror gained the matching namespace with the byok facts as its base layer — no key material anywhere on the wire",
    "the RELAUNCH resolution works: boot #2 with no staged credential reads the keychain through upstream/llm-route.js and boots the byok route — the relaunch path composer-web-live serves",
    "the FIRST TURN rides the page's own wire over the rebound route: session/create → session/prompt → the scripted 'Hello from upstream' — the credential path is exercised end to end",
    "the CLEAR leg (onboarding/clear) deletes the keychain ref (the frozen delete half) and restores the boot route LIVE through the registered factory: the status answers mock again, the directory row swaps back to the boot provider, and a SECOND TURN answers from the restored mock adapter with no relaunch — the call takes no arguments and no key crosses the wire",
    "the key audit is green: the mock key and the wrong-key probe value appear nowhere in the raw log"
  ],
  "checker": "test/e2e/scenarios/onboarding-flow.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

echo "e2e: PASS $ART_DIR" >&2
