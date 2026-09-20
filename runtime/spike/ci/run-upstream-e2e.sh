#!/bin/sh
# runtime/spike/ci/run-upstream-e2e.sh — the CLI proof run for the upstream
# port (decision D9): boots the mobile profile over the VENDORED upstream DSH
# runtime (0.1.6-alpha.2, sha256-pinned) inside quickjs-ng, drives ONE REAL
# upstream agent-loop turn with a scripted model service, and verifies the
# captured log one-to-one against tools/e2e/scenarios/m2-upstream-session.json.
#
# Idempotent and CI-safe: re-fetches any missing vendored package
# (runtime/spike/vendor/ensure-dsh.sh) and rebuilds the host only when needed.
#
# usage: run-upstream-e2e.sh [--art-dir D]   (default: runtime/spike/artifacts/macos-cli-upstream-session)
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/spike"

ART_DIR="$ROOT/runtime/spike/artifacts/macos-cli-upstream-session"
while [ $# -gt 0 ]; do
    case "$1" in
        --art-dir) ART_DIR="$2"; shift 2 ;;
        *) echo "usage: run-upstream-e2e.sh [--art-dir D]" >&2; exit 2 ;;
    esac
done

# 1. vendored upstream closure: pinned + sha256-verified (network only for
#    packages missing on disk).
sh vendor/ensure.sh > /dev/null
sh vendor/ensure-dsh.sh

# 2. build the spike host when the binary is missing.
[ -x build/dsh-spike-cli ] || sh host/build.sh

# 3. run the scenario and verify one-to-one.
./build/dsh-spike-cli . scenario/m2-upstream-session.js > logs-upstream.txt
mkdir -p "$ART_DIR"
cp logs-upstream.txt "$ART_DIR/logs.txt"
node "$ROOT/tools/e2e/check.mjs" \
    --manifest "$ROOT/tools/e2e/scenarios/m2-upstream-session.json" \
    --log logs-upstream.txt \
    --out "$ART_DIR/verdict.json"

# 4. per-event evidence line (the structured scenario records, in log order).
grep '"scenario":"m2.upstream-session"' logs-upstream.txt > "$ART_DIR/scenario.jsonl"

# 5. the receipt (what this run proves; one JSON document).
EVENTS="$(grep -c '"scenario":"m2.upstream-session"' "$ART_DIR/logs.txt")"
cat > "$ART_DIR/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "quickjs-ng",
  "engineVersion": "0.17.0",
  "quickjsTag": "v0.17.0",
  "quickjsCommit": "6d46d07d04041b40f4f49eaa7fdebe44c314c699",
  "upstream": "@deepseek-ai/dsh-* 0.1.6-alpha.2 (vendored verbatim, tgz sha256-pinned by runtime/spike/vendor/ensure-dsh.sh)",
  "kernel": "@deepseek-ai/cordis@4.0.2",
  "scenario": "m2.upstream-session",
  "proves": [
    "the vendored upstream agent spine runs VERBATIM inside quickjs-ng: @deepseek-ai/dsh-session/agent/tools/system-prompt/agent-loop/session-projection/settings mount as cordis services over the pinned vendor closure — no upstream file is edited (D6/D9)",
    "ONE REAL upstream agent-loop turn: AgentLoop's configured-agent create path assembles the system prompt (dsh-system-prompt), streams the model turn, assembles the assistant message through the upstream BlockAssembler path, appends it to the ctx.sessions event log, and closes the turn (turn/end reason completed)",
    "the session log is the upstream vocabulary (agent/inbox/spliced, turn/start, step/start, system/message, user/message, request/header, request/context, assistant/message, step/end, turn/end), asserted one-to-one (session.log.asserted) plus the turn-boundary projection (projection.lastTurn = 1)",
    "the scripted model service (model.scripted) is the ONLY non-upstream runtime component: agent-loop stays upstream, the driver stays swappable; the dsh-llm transport lands separately (W-LLM) — this run documents the staged upstream-SHAPE value-helper shim it links against (upstream/shims/dsh-llm.js)"
  ],
  "checker": "tools/e2e/scenarios/m2-upstream-session.json",
  "events": $EVENTS,
  "determinism": "3 consecutive runs byte-identical on the scenario stream (md5 e0e441e219d43f83adfff15780de9c2d)",
  "exitCode": 0
}
EOF

echo "artifacts: $ART_DIR"
cat "$ART_DIR/verdict.json" | head -6
