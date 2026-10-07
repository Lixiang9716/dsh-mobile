#!/bin/sh
# runtime/dsh/ci/run-shim-exposure-probe.sh — the CLI proof run for the
# shim exposure survey's behavior legs (T-0078, 2026-09-30): the survey
# (DSH_MODULE_MANIFEST sweep + tools/shim-exposure.mjs) found one shim the
# 681-spec suite never loads and a thin tail it barely presses; this leg
# presses the five riskiest faces by product path — the orphaned
# dsh-session-persistence error protocol, node:sqlite over :memory:,
# node:string_decoder's chunk-boundary hold, partial-json + openai-client's
# truncated-JSON/SSE wire faces, and slot-registry's boot-once/registration
# guards.
#
# No mock server: the OpenAI wire face drives an injected stub fetch.
#
# The captured log is verified one-to-one against
# test/e2e/scenarios/shim-exposure-probe.json. Artifacts:
# runtime/dsh/artifacts/macos-cli-shim-exposure-probe/.
#
# usage: run-shim-exposure-probe.sh   (artifacts: .../macos-cli-shim-exposure-probe)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/dsh"

ART_DIR="$ROOT/runtime/dsh/artifacts/macos-cli-shim-exposure-probe"

# 1. vendored upstream closure: pinned + sha256-verified (the slot-registry
#    leg imports @deepseek-ai/cordis + the client-ui-slots package).
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-cli ] || sh host/build.sh

# 3. run the scenario and verify one-to-one. DSH_MODULE_MANIFEST rides the
#    SAME run on purpose (default-off switch; the env only opens the
#    side-channel file — the log is unchanged): the committed manifest.txt is
#    the survey mechanism's standing in-repo proof, every line a shim load.
mkdir -p "$ART_DIR"
DSH_MODULE_MANIFEST="$ART_DIR/manifest.txt" \
    ./build/dsh-cli . scenario/shim-exposure-probe.js > logs-shim-exposure-probe.txt
cp logs-shim-exposure-probe.txt "$ART_DIR/logs.txt"
grep '^dsh.spike.log:' logs-shim-exposure-probe.txt > "$ART_DIR/scenario.jsonl"
# The manifest must be real (rule 5): non-empty, every line a shim load.
[ -s "$ART_DIR/manifest.txt" ] || {
    echo "e2e: FAIL — DSH_MODULE_MANIFEST produced no manifest (switch broken?)" >&2
    exit 1
}
if grep -qv '^upstream/shims/' "$ART_DIR/manifest.txt"; then
    echo "e2e: FAIL — manifest carries a non-shim line:" >&2
    grep -v '^upstream/shims/' "$ART_DIR/manifest.txt" | head -3 >&2
    exit 1
fi
node "$ROOT/test/e2e/check.mjs" \
    --manifest "$ROOT/test/e2e/scenarios/shim-exposure-probe.json" \
    --log logs-shim-exposure-probe.txt \
    --out "$ART_DIR/verdict.json"

# 4. the receipt (what this run proves; one JSON document).
EVENTS="$(grep -c '"scenario":"shim.exposure-probe"' logs-shim-exposure-probe.txt)"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "quickjsTag": "v0.17.0",
  "quickjsCommit": "6d46d07d04041b40f4f49eaa7fdebe44c314c699",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, tgz sha256-pinned by runtime/dsh/vendor/ensure-dsh.sh)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "shim.exposure-probe",
  "proves": [
    "the survey's zero-exposure shim dsh-session-persistence.js still carries its resume-path error protocol: all four error classes construct as Error with their own name and the carried sessionId in the message (the file is loader-orphaned since the vendored dsh-session-persistence package took the mapping — this leg pins the face a re-mapping must keep)",
    "node:sqlite round-trips over :memory: through the host sqlite3 seam: create/insert/get/iterate with node's no-row-is-undefined face (the W6-V distinction), the suite pressing this shim only 3/648 runs",
    "node:string_decoder holds a multi-byte sequence split 2/1 across chunk writes (no U+FFFD for a merely-split char), decodes a stray continuation byte to U+FFFD, and rejects non-utf8 labels loud — 7/648 spec runs",
    "partial-json completes truncated LLM wire JSON at four truncation shapes (object/array/escaped-quote/dangling-escape) and passes literals through; openai-client streams an SSE body with a frame split mid-JSON into parsed chunks ending at [DONE] and throws the SDK's status/error shape on 401 — 5/648 spec runs each",
    "slot-registry mounts through cordis (ctx.slots live), rejects the second install() boot-once, refuses child keys at ctx-level renderSlot, and refuses an unregistered root — the UI mount's guard faces, 5/648 spec runs",
    "the survey mechanism itself, with this very run: DSH_MODULE_MANIFEST=<artifacts>/manifest.txt makes the loader record every resolved shim load (the file is committed beside this receipt; every line matches upstream/shims/)"
  ],
  "checker": "test/e2e/scenarios/shim-exposure-probe.json",
  "events": $EVENTS,
  "exitCode": 0
}
EOF

echo "e2e: PASS $ART_DIR" >&2
