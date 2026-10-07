#!/usr/bin/env bash
# test/e2e/write-receipt.sh — the SHARED evidence-receipt writer (acceptance-
# bar clause 3, docs/e2e-matrix.md): every evidence dir carries receipt.json,
# machine-authored, reachable ONLY from a real green run — a receipt can never
# exist without the run that produced it (never synthesized).
#
# Extracted from run-ios.sh (the five iOS runners carried five copies of the
# same block; the matrix's verdict-present → full-deliverable-set rule kept
# tripping on dirs whose runner predates the clause).
#
# usage: write-receipt.sh <ART_DIR> <UDID> <RUNNER_PATH> <PHASE>
#                         <LAUNCH_CONFIG> <manifest-stem> [<manifest-stem>...]
#   manifest stems are BARE (no path, no .json — `boot-verification`, exactly
#   the iOS runners' convention); each must have a verdict-<stem>.json beside
#   it in ART_DIR (the runner's own checkers).
#
# Non-iOS hosts (the android/harmony runners) set DSH_RECEIPT_HOST to their
# host line — adb serial + AVD + API level, or the hdc target + HarmonyOS
# version — and the writer skips the xcrun simctl query entirely; when the
# variable is unset the iOS lookup runs unchanged. Screens ride `screens/`
# when the dir exists (the iOS runners' layout) and top-level `*.png`
# otherwise (the harmony runner lays its shots loose in the artifacts dir).
set -eu
ART="$1"; UDID="$2"; RUNNER="$3"; PHASE="$4"; LAUNCH="$5"; shift 5
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

TREE_LINE="origin/main $(git rev-parse --short=12 HEAD)$(git diff-index --quiet HEAD -- || echo ' (dirty working tree at receipt time)')"
ENGINE_PIN="$(sed -n 's/^PIN=//p' runtime/dsh/vendor/ensure.sh)"
python3 - "$ART" "$UDID" "$TREE_LINE" "$ENGINE_PIN" "$RUNNER" "$PHASE" "$LAUNCH" "$@" <<'PY'
import json, os, subprocess, sys
from datetime import datetime
art, udid, tree, engine_pin, runner, phase, launch = sys.argv[1:8]
checker_ids = sys.argv[8:]
host_override = os.environ.get("DSH_RECEIPT_HOST", "")
if host_override:
    host = host_override
else:
    out = subprocess.run(["xcrun", "simctl", "list", "devices", "-j"],
                         capture_output=True, text=True, check=True).stdout
    devs = json.loads(out)["devices"]
    def pretty(rt):  # com.apple.CoreSimulator.SimRuntime.iOS-26-5 -> iOS 26.5
        parts = rt.rsplit("SimRuntime.", 1)[-1].split("-")
        return parts[0] + " " + ".".join(parts[1:])
    host = next(f'{d["name"]} simulator ({udid}, {pretty(rt)})'
                for rt, ds in devs.items() for d in ds if d.get("udid") == udid)
scenarios = []
for sid in checker_ids:
    # Two verdict namings exist: the per-checker verdict-<stem>.json (run-ios
    # and the four use-case runners) and the single verdict.json (agent-flow,
    # whose manifest is one). Prefer the specific, fall back to the shared.
    path = os.path.join(art, f"verdict-{sid}.json")
    if not os.path.exists(path):
        path = os.path.join(art, "verdict.json")
    v = json.load(open(path))
    scenarios.append({
        "id": v["scenario"],
        "checker": f"test/e2e/scenarios/{sid}.json",
        "events": v["logged"],
        "result": "pass" if v["pass"] else "fail",
    })
screens = []
screens_dir = os.path.join(art, "screens")
if os.path.isdir(screens_dir):
    screens += sorted("screens/" + f
                      for f in os.listdir(screens_dir) if f.endswith(".png"))
screens += sorted(f for f in os.listdir(art)
                  if f.endswith(".png") and os.path.isfile(os.path.join(art, f)))
receipt = {
    "host": host if host_override else "iOS " + host,
    "engine": "quickjs-ng",
    "engineVersion": engine_pin,
    "phase": phase,
    "launchConfiguration": launch,
    "tree": tree,
    "scenarios": scenarios,
    "runner": runner,
    "screens": screens,
    "timestamp": datetime.now().astimezone().isoformat(timespec="seconds"),
    "exitCode": 0,
}
with open(os.path.join(art, "receipt.json"), "w") as f:
    json.dump(receipt, f, indent=2)
    f.write("\n")
print("receipt written (write-receipt.sh)")
PY
