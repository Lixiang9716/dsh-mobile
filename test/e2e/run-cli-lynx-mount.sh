#!/bin/sh
# test/e2e/run-cli-lynx-mount.sh — the lynx.mount E2E leg, CLI host: the
# lynx-client driver loop (mock SessionServe over real loopback HTTP+WS →
# adapter → RenderSurfaceClient seam) run TWICE over the SAME flow — once per
# skin — to prove the seam is genuinely replaceable:
#
#   lynx face: driver/skin-lynx.js host:'cli' — the bundle's REAL seam core
#     (shared/surface-core.js, the module compiled into main.lynx.bundle)
#     plus the artifact sha256 verification; pixels stay engine-only.
#   stub face: driver/skin-stub.js — the plain-text transcription.
#
# Evidence discipline mirrors runtime/dsh/ci/run-settings-surfaces-e2e.sh:
# per face, logs.txt + scenario.jsonl (the dsh.runtime.log: lines) + verdict.json
# (test/e2e/check.mjs one-to-one against test/e2e/scenarios/lynx-mount.json
# and lynx-mount-stub.json) + receipt.json — the receipt is written only at
# the end, after BOTH checkers passed (a failed run never leaves one). The
# artifacts are committed (the macos-cli-settings-surfaces precedent): the
# e2e-matrix gate audits them from the working tree.
#
# usage: test/e2e/run-cli-lynx-mount.sh
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ARTS="$ROOT/presentation/lynx-client/artifacts"

PROVES_COMMON='"the RenderSurfaceClient seam is genuinely replaceable: the SAME driver loop — mock SessionServe over real loopback HTTP+WS, the {args:{request}} envelope, the one subscription point, the domain→view adapter, the seed protocol — drives two different skins to the identical 34-record structured-log contract",
  "the full mock LLM arc holds end to end: session select + create → submit → the streamed turn (message deltas: start/reasoning/text/end) with the tool card through all three phases (streaming → waiting → ok) → the collapsed result with output → the creation card → the settled title",
  "a mid-history re-open replays the seed burst and rebuilds the thread (the seed.replayed record fires exactly when the seed-end view event crosses the seam)",
  "an optimistic cancel settles as 已停止 with the streaming tail dropped, and the cancelled reply never settles as text",
  "unknown intents and unknown view events fail loud — same-package-same-version, no forward tolerance"'

write_receipt() { # ART_DIR FACE MANIFEST EVENTS
  cat > "$1/receipt.json" <<EOF
{
  "host": "$(uname -s | tr '[:upper:]' '[:lower:]')-cli ($(uname -sr) $(uname -m))",
  "engine": "node $(node --version)",
  "scenario": "lynx.mount",
  "face": "$2",
  "proves": [
    $PROVES_COMMON
  ],
  "checker": "test/e2e/scenarios/$3",
  "events": $4,
  "exitCode": 0
}
EOF
}

run_face() { # FACE MANIFEST
  ART="$ARTS/cli-lynx-mount-$1"
  echo "lynx-mount: face $1 -> $ART"
  mkdir -p "$ART"
  node test/e2e/lynx-mount.mjs --skin "$1" > "$ART/logs.txt"
  grep '^dsh.runtime.log:' "$ART/logs.txt" > "$ART/scenario.jsonl"
  node test/e2e/check.mjs \
    --manifest "$ROOT/test/e2e/scenarios/$2" \
    --log "$ART/logs.txt" \
    --out "$ART/verdict.json"
  EVENTS="$(grep -c "\"face\":\"$1\"" "$ART/logs.txt")"
  write_receipt "$ART" "$1" "$2" "$EVENTS"
}

run_face lynx lynx-mount.json
run_face stub lynx-mount-stub.json

echo "lynx-mount: PASS (both faces green; verdicts + receipts under $ARTS/cli-lynx-mount-{lynx,stub})"
