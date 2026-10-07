#!/usr/bin/env bash
# tools/test/run-simulator-matrix.sh — the simulator test matrix: a
# release-grade evidence net per platform, one command.
#
# WHY: the CI pipelines build the hosts but the simulator E2E legs lived
# scattered across per-milestone runners with no single driver that says
# "the shipping configuration boots clean AND the harness drives the whole
# app, on this machine, today". This script is that driver. It runs, per
# platform, BOTH halves the repo's flavor split defines (AGENTS.md
# constraint 5 / rules.md rule L4):
#
#   release leg   the user-facing build, plain-launched on the simulator:
#                 zero E2E machinery asserted (0 spike.log / 0 verdict /
#                 0 debug+info / 0 audit), the official surface reached,
#                 and an E2E drive REFUSED BY NAME (rule 5). The release
#                 configuration CANNOT run the e2e drives — the drives are
#                 compiled out of it by design and the binary refuses them
#                 loudly — so the release leg's evidence is exactly that
#                 absence + refusal, and the scenario coverage rides the
#                 harness half below.
#   harness legs  the debug harness (the verification vehicle) running the
#                 existing e2e runners unchanged: iOS the full UI-driven
#                 gateway drive + the device-plane ladder (run-ios.sh,
#                 run-ios-device-plane.sh), Android the three-scenario
#                 regression (run-spike-e2e.sh) + the device-plane leg
#                 (run-device-plane.sh). Scenario-id logs 1:1 against the
#                 manifests, receipts machine-authored on the green path
#                 only.
#
# Harmony: honestly skipped when no DevEco toolchain / simulator target
# exists on the machine — a skip receipt is written, never a fake pass
# (D-g: the leg stays script-ready for a real device).
#
# Capability skips: legs that need a driver the machine lacks (idb/WDA on
# iOS) auto-skip with a trace; hardware a simulator does not have (camera,
# Bluetooth, NFC...) is recorded as a standing baseline row — future
# system-capability scenarios must negotiate `unavailable` through the
# capability plane, never assume the hardware.
#
# Discipline: every wait polls a condition with a deadline (rules.md rule
# 8 — sleeps only pace polling or bound a real observation window whose
# assertions are read after it); every exhaustion is loud (rule 5); any
# failing leg stops the platform (fail fast) and fails the run.
#
# Evidence: hosts/<plat>/artifacts/simulator-matrix/<leg>/ following the
# committed-leg shape (logs.txt, scenario.jsonl, verdict*.json,
# receipt.json where verdicts exist; release legs carry release-proof.json
# instead — they have no checker verdicts to receipt). The e2e-matrix gate
# walks these dirs: a dir with verdict*.json must carry the full
# deliverable set, and it does or the run stays red.
#
# usage: run-simulator-matrix.sh [--platform ios|android|harmony|all]
#                                [--skip-release] [--skip-harness]
# env:   DSH_E2E_UDID        iOS simulator (default: dsh-iphone)
#        DSH_ANDROID_SERIAL  emulator serial (default: emulator-5554)
#        DSH_ANDROID_AVD     AVD to boot when no emulator is up (pixel)
#        DSH_MATRIX_KEEP_GOING=1  run every requested leg instead of
#                            stopping at the first failure (the summary
#                            still exits non-zero)
set -euo pipefail
# A bash guard BEFORE anything: under a POSIX sh this script's arrays and
# pipefail are lies — fail loud instead of half-running (rule 5).
[ -n "${BASH_VERSION:-}" ] || { echo "matrix: run me with bash, not sh" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
[ -f AGENTS.md ] || mx_die "not at the repository root (ROOT=$ROOT) — refusing to scatter artifacts"

IOS_UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ADB_SERIAL="${DSH_ANDROID_SERIAL:-emulator-5554}"
ANDROID_AVD="${DSH_ANDROID_AVD:-pixel}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/microsoft-17.jdk/Contents/Home}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$JAVA_HOME/bin:$PATH"
IOS_BUNDLE=org.dsh.DSHSpike
ANDROID_PKG=com.dshmobile.spike
KEEP_GOING="${DSH_MATRIX_KEEP_GOING:-0}"
STATE="$(mktemp /tmp/dsh-matrix-state.XXXXXX)"
OVERALL=0

# ---- shared helpers ---------------------------------------------------------

mx()    { echo "matrix: $*"; }
mx_die(){ echo "matrix: FAIL: $*" >&2; exit 1; }

# A leg outcome is recorded even when the run dies afterwards — the state
# file outlives the failure and the summary prints it.
record() { # PLATFORM LEG STATUS DETAIL
    printf '%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" >> "$STATE"
    mx "[$1] $2 -> $3 (${4:0:110})"
}

# poll_until DEADLINESeconds CMD... — condition polling, never clock-waiting
# (rule 8): CMD re-runs until it exits 0 or the deadline passes (2 s pacing).
# PASS A COMMAND RE-RUN, not an inline `[ "$(…)" ]` condition: the
# substitution evaluates ONCE while building the arguments, so the loop
# would re-poll a CONSTANT until the deadline (measured; wrap conditions in
# a function — see android_booted).
poll_until() {
    local deadline=$(( SECONDS + $1 )); shift
    until "$@" >/dev/null 2>&1; do
        [ "$SECONDS" -lt "$deadline" ] || return 1
        sleep 2
    done
}

node_bin() { # the runners' checkers need node; it is off the non-interactive PATH
    local n
    n="$(command -v node 2>/dev/null || true)"
    if [ -z "$n" ]; then
        for n in "$HOME"/.nvm/versions/node/*/bin/node; do
            [ -x "$n" ] && { dirname "$n"; return 0; }
        done
        return 1
    fi
    dirname "$n"
}

png_valid() { # a screenshot is debugging evidence, but the matrix checker
              # still magic-verifies every PNG under evidence dirs
    [ "$(xxd -p -l 8 "$1" 2>/dev/null)" = "89504e470d0a1a0a" ]
}

count_of() { grep -c -F "$2" "$1" 2>/dev/null || true; }

engine_pin() { sed -n 's/^PIN=//p' runtime/dsh/vendor/ensure.sh; }
tree_line() {
    echo "origin/main $(git rev-parse --short=12 HEAD)$(git diff-index --quiet HEAD -- || echo ' (dirty working tree at receipt time)')"
}

# materialize() — the untracked trees every build embeds (D6/D9): the pinned
# quickjs engine + upstream DSH closure + the official web dist + client
# bundles. Fresh worktrees start without all four; fail loud, never half-build.
materialize() {
    mx "materializing the untracked build trees (engine, dsh closure, dist, bundles)"
    sh runtime/dsh/vendor/ensure.sh || mx_die "runtime/dsh/vendor/ensure.sh failed"
    sh runtime/dsh/vendor/ensure-dsh.sh || mx_die "runtime/dsh/vendor/ensure-dsh.sh failed"
    # these two are bash-only (set -o pipefail, BASH_SOURCE) — sh(1) here is dash
    bash test/e2e/ensure-official-dist.sh || mx_die "test/e2e/ensure-official-dist.sh failed"
    bash test/e2e/ensure-client-bundles.sh || mx_die "test/e2e/ensure-client-bundles.sh failed"
}

# ---- iOS --------------------------------------------------------------------

ios_m() { echo "hosts/ios/artifacts/simulator-matrix"; }

ios_boot() { # boot once, conditionally: bootstatus + a real readiness probe
    xcrun simctl boot "$IOS_UDID" 2>/dev/null || true   # already booted is fine
    xcrun simctl bootstatus "$IOS_UDID" -b >/dev/null
    poll_until 60 xcrun simctl spawn "$IOS_UDID" launchctl print system \
        || mx_die "simulator $IOS_UDID never reached launchd readiness (60s)"
    bash hosts/ios/Tools/sim-preflight.sh "$IOS_UDID" \
        || mx_die "simulator preflight failed (the 18.5 dyld trap is real — see the script)"
}

ios_app_alive() {
    xcrun simctl spawn "$IOS_UDID" launchctl list 2>/dev/null | grep -F "$IOS_BUNDLE" >/dev/null
}

# ios_generate() — the D9 flip: App/Generated/ and DSHSpike.xcodeproj/ are
# build output; a fresh worktree regenerates them (gen.sh needs xcodegen).
ios_generate() {
    command -v xcodegen >/dev/null || mx_die "xcodegen missing — brew install xcodegen"
    sh hosts/ios/gen.sh || mx_die "hosts/ios/gen.sh failed"
}

ios_install() { # $1 = .app path
    xcrun simctl terminate "$IOS_UDID" "$IOS_BUNDLE" 2>/dev/null || true
    xcrun simctl uninstall "$IOS_UDID" "$IOS_BUNDLE" 2>/dev/null || true
    xcrun simctl install "$IOS_UDID" "$1" || mx_die "simctl install failed for $1"
    local data
    data="$(xcrun simctl get_app_container "$IOS_UDID" "$IOS_BUNDLE" data)"
    [ -z "$(ls -A "$data/Documents" 2>/dev/null)" ] \
        || mx_die "container Documents is not empty before the launch (staging would leak into the plain launch)"
}

# ios_launch TAG [ARGS...] — bounded launch with SpringBoard retry; stdout
# and stderr land in $ART/<tag>.{stdout,stderr}.txt
ios_launch() {
    local tag="$1"; shift
    local art="$CURRENT_ART" ok=1 deadline=$((SECONDS + 60))
    local out="$art/$tag.stdout.txt" err="$art/$tag.stderr.txt"
    while [ "$SECONDS" -lt "$deadline" ]; do
        # simctl resolves relative capture paths outside this cwd — absolute only
        perl -e 'alarm shift; exec @ARGV' 180 \
            xcrun simctl launch --terminate-running-process \
            --stdout="$ROOT/$out" --stderr="$ROOT/$err" \
            "$IOS_UDID" "$IOS_BUNDLE" "$@" >"$art/$tag.launch.txt" 2>&1 && { ok=0; break; }
        sleep 3
    done
    [ "$ok" -eq 0 ] || { cat "$art/$tag.launch.txt" >&2; mx_die "the $tag launch never took (SpringBoard refused for 60s)"; }
}

# ios_refusal_launch — the refusal probe CANNOT ride ios_launch: the release
# binary fatalErrors on a requested drive, so `simctl launch` exits 3
# (launched-then-crashed) on the SUCCESS path. One bounded attempt, outcome
# tolerated; the oslog text is the verdict (polled by the caller).
ios_refusal_launch() { # ARGS...
    local art="$CURRENT_ART"
    perl -e 'alarm shift; exec @ARGV' 60 \
        xcrun simctl launch --terminate-running-process \
        --stdout="$ROOT/$art/refusal.stdout.txt" --stderr="$ROOT/$art/refusal.stderr.txt" \
        "$IOS_UDID" "$IOS_BUNDLE" "$@" >"$art/refusal.launch.txt" 2>&1 \
        || true   # exit 3 = the app refused and died — exactly the expectation
}

ios_release_leg() {
    local art="hosts/ios/artifacts/simulator-matrix/release"
    local dd="${DSH_IOS_RELEASE_DD:-/tmp/dsh-sim-matrix-ios-release-dd}"
    local rel="$dd/Build/Products/Release-iphonesimulator/DSHSpike.app"
    CURRENT_ART="$art"
    mkdir -p "$art"

    mx "release leg: xcodebuild -configuration Release"
    xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
        -configuration Release -destination "platform=iOS Simulator,id=$IOS_UDID" \
        -derivedDataPath "$dd" 2>&1 | tail -3 \
        || mx_die "xcodebuild Release failed"
    [ -d "$rel" ] || mx_die "release app bundle missing: $rel"

    ios_install "$rel"
    ios_launch plain-launch-release
    # No completion tag exists in a user-facing build; the boot is proved by
    # the process surviving an observation window, then the absence counts
    # and the screenshot are read AFTER that window (assertion follows wait).
    poll_until 90 ios_app_alive || mx_die "the release app never appeared in launchctl"
    local held=0
    while [ "$held" -lt 20 ]; do
        ios_app_alive || mx_die "the release app died inside the observation window"
        sleep 2; held=$((held + 2))
    done
    xcrun simctl io "$IOS_UDID" screenshot "$art/plain-launch-release.png" 2>/dev/null || true
    png_valid "$art/plain-launch-release.png" || mx_die "release screenshot is not a valid PNG"
    local since; since="$(date '+%Y-%m-%d %H:%M:%S')"
    # Read the unified log AFTER the fact: a live `log stream` holds the
    # device busy and makes SpringBoard refuse launches (measured in the
    # release-logging runner this leg mirrors).
    xcrun simctl spawn "$IOS_UDID" log show --start "$since" \
        --predicate 'process == "DSHSpike"' --style compact > "$art/plain-launch-release.oslog.txt" 2>&1 || true

    # At least one capture channel must carry bytes — a dead capture makes
    # every zero count vacuous (the absence must be a REAL absence).
    [ -s "$art/plain-launch-release.stdout.txt" ] || [ -s "$art/plain-launch-release.stderr.txt" ] \
        || [ -s "$art/plain-launch-release.oslog.txt" ] \
        || mx_die "all release captures are empty — nothing was observed, nothing is proven"

    # WHAT THE FLAVOR SPLIT STILL GUARANTEES (asserted zero everywhere):
    #  - drive choreography markers (sequence / ui-wait / announced modes /
    #    verdict text / result tags) — the drives are compiled OUT of release;
    #  - '"level":"debug"' / '"level":"info"' — L4: release keeps warn/error.
    # WHAT IS THE PRODUCT'S OWN PLANES, NOT TEST MACHINERY (recorded, never
    # asserted zero — measured stale the hard way: the committed
    # release-logging runner's 0-records/0-audit assertions fail on today's
    # main because the serving boot brings up the full agent spine, whose
    # audit lines ride NSLog regardless of flavor and whose warn records L4
    # keeps; see the surprise ledger): dsh.gateway.audit lines and
    # warn/error-level dsh.spike.log records. Their counts are recorded in
    # release-proof.json as observed fact.
    local f
    for f in "$art/plain-launch-release.stdout.txt" "$art/plain-launch-release.stderr.txt" \
             "$art/plain-launch-release.oslog.txt"; do
        for pat in 'spike: sequence' 'spike: ui-wait' 'spike: app launched' \
                   'dsh.spike.verdict' 'dsh.spike.result' 'ALL PASS' 'ALL FAIL' \
                   '"level":"debug"' '"level":"info"'; do
            [ "$(count_of "$f" "$pat")" -eq 0 ] \
                || mx_die "release emitted drive machinery '$pat' in $f — the flavor split regressed"
        done
    done
    local audit_n warn_n
    audit_n=0
    for f in "$art/plain-launch-release.stdout.txt" "$art/plain-launch-release.stderr.txt" \
             "$art/plain-launch-release.oslog.txt"; do
        audit_n=$((audit_n + $(count_of "$f" 'dsh.gateway.audit:')))
    done
    warn_n=0
    for f in "$art/plain-launch-release.stdout.txt" "$art/plain-launch-release.stderr.txt" \
             "$art/plain-launch-release.oslog.txt"; do
        warn_n=$((warn_n + $(count_of "$f" '"level":"warn"')))
    done

    # The refusal (rule 5): a release binary asked for a drive refuses BY NAME.
    since="$(date '+%Y-%m-%d %H:%M:%S')"
    xcrun simctl terminate "$IOS_UDID" "$IOS_BUNDLE" 2>/dev/null || true
    ios_refusal_launch -dsh-mode session
    local deadline=$((SECONDS + 45)) refused=0
    while [ "$SECONDS" -lt "$deadline" ]; do
        xcrun simctl spawn "$IOS_UDID" log show --start "$since" \
            --predicate 'process == "DSHSpike"' --style compact > "$art/refusal.oslog.txt" 2>&1 || true
        grep -q "release build: refusing '-dsh-mode session'" "$art/refusal.oslog.txt" && { refused=1; break; }
        sleep 2
    done
    [ "$refused" -eq 1 ] || mx_die "the release build did not refuse '-dsh-mode session' within 45s"

    python3 - "$art" "$IOS_UDID" "$audit_n" "$warn_n" <<'PY'
import json, subprocess, sys, os
from datetime import datetime
art, udid, audit_n, warn_n = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
out = subprocess.run(["xcrun", "simctl", "list", "devices", "-j"], capture_output=True, text=True, check=True).stdout
devs = json.loads(out)["devices"]
def pretty(rt):
    p = rt.rsplit("SimRuntime.", 1)[-1].split("-")
    return p[0] + " " + ".".join(p[1:])
host = next(f'{d["name"]} ({udid}, {pretty(rt)})' for rt, ds in devs.items() for d in ds if d.get("udid") == udid)
proof = {
    "leg": "release",
    "configuration": "Release (the user-facing distribution build)",
    "host": "iOS " + host,
    "engine": "quickjs-ng",
    "engineVersion": os.environ.get("DSH_MATRIX_ENGINE_PIN", ""),
    "tree": os.environ.get("DSH_MATRIX_TREE", ""),
    "assertions": {
        "driveMachineryMarkers": 0,
        "assertedZero": ["spike: sequence", "spike: ui-wait", "spike: app launched",
                          "dsh.spike.verdict", "dsh.spike.result", "ALL PASS", "ALL FAIL",
                          "level:debug records", "level:info records"],
        "officialUiReached": "plain-launch-release.png",
        "driveRefusal": "refusal.oslog.txt — refusing '-dsh-mode session' by name",
    },
    "observedNotAsserted": {
        "gatewayAuditLines": audit_n,
        "warnLevelRecords": warn_n,
        "note": "the product's own planes on today's serving boot (the audit stream rides "
                "NSLog regardless of flavor; L4 keeps warn/error) — recorded as fact, never "
                "asserted zero (the committed release-logging 0/0 assertions are stale "
                "against this tree; see the surprise ledger)"
    },
    "producedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
}
with open(os.path.join(art, "release-proof.json"), "w") as f:
    json.dump(proof, f, indent=2); f.write("\n")
PY
    [ -f "$art/release-proof.json" ] || mx_die "the release-proof.json writer lied (file absent) — refusing to record"
    record ios release PASS "0 drive markers / 0 debug+info; audit=$audit_n warn=$warn_n (product planes, recorded); refusal by name; proof in $art/release-proof.json"
}

# (The picker-target restage that used to live here is GONE, on measured
# evidence: its premise — "staging here gives the index the whole harness
# build + reboot to settle" — is false in exactly the case it exists for.
# run-ios.sh REBOOTS the simulator in step 3/6, AFTER the build, and the
# reboot restarts the file-provider indexing from scratch: a target staged
# here reads as "already staged — untouched" in run-ios.sh while its index
# visibility is post-reboot fresh, and the gateway drive's picker search
# starved on exactly that shape (2026-09-30, matrix attempt 6: staged 20:34,
# reboot ~20:36, searched ~20:39, 未找到相关结果). run-ios.sh now owns the
# whole lifecycle: create-if-missing after its own reboot, and pace the
# measured settle window whenever the staged file predates that reboot.)

# ios_idb_present — THE idb probe, one definition (ios_platform's
# capability-skips write and the harness leg's skip decision must never
# diverge on what the machine can drive).
ios_idb_present() {
    command -v idb >/dev/null 2>&1 && idb list-targets 2>/dev/null | grep -q "$IOS_UDID"
}

ios_harness_leg() {
    local m; m="$(ios_m)"
    local node_dir; node_dir="$(node_bin)" || mx_die "node not found (checkers cannot run)"
    export PATH="$node_dir:$PATH"
    export IDB_UDID="$IOS_UDID"
    # idb is the ONLY local UI driver for the system surfaces the drives
    # block on. Without it the drive legs cannot be driven — that is a
    # declared capability skip, not a pass and not a silent omission.
    # capability-skips.json itself is written ONCE by ios_platform from the
    # same ios_idb_present probe (this leg only decides + records).
    if ! ios_idb_present; then
        record ios harness SKIP "no idb UI driver — the UI-driven harness legs are skipped (traced in capability-skips.json)"
        return 0
    fi
    mx "harness leg 1/2: run-ios.sh (gateway binding, the full UI drive)"
    test/e2e/run-ios.sh --udid "$IOS_UDID" \
        --art-dir "$m/gateway-drive" \
        || { archive_failed_dir ios gateway-drive; record ios gateway-drive FAIL "run-ios.sh exited non-zero — its dir moved to /tmp for diagnosis"; return 1; }
    record ios gateway-drive PASS "4 verdicts green + receipt (boot, carrier, gateway binding, audit)"

    mx "harness leg 2/2: run-ios-device-plane.sh (the v1.5.0 capability ladder)"
    test/e2e/run-ios-device-plane.sh --udid "$IOS_UDID" \
        --art-dir "$m/device-plane" --skip-build \
        || { archive_failed_dir ios device-plane; record ios device-plane FAIL "run-ios-device-plane.sh exited non-zero — dir moved to /tmp"; return 1; }
    record ios device-plane PASS "device.plane + audit verdicts green + receipt"
}

ios_capability_skips() { # PRESENT(yes|no) REASON
    local art; art="$(ios_m)"
    mkdir -p "$art"
    python3 - "$art" "$1" "$2" "$IOS_UDID" <<'PY'
import json, sys
from datetime import datetime
art, present, reason, udid = sys.argv[1], sys.argv[2] == "yes", sys.argv[3], sys.argv[4]
doc = {
    "platform": "ios",
    "target": udid,
    "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
    "probed": [
        {"driver": "idb", "present": present, "reason": reason,
         "skippedLegs": [] if present else ["gateway-drive", "device-plane"],
         "note": "the drives block on system UI (alerts, banner, picker) only idb/WDA can reach"},
    ],
    "hardware": [
        {"capability": c, "status": "no-simulator-hardware",
         "baseline": "a simulator exposes no camera/BT/NFC radio; when the system "
                     "capability face lands, its scenarios negotiate `unavailable` "
                     "through the capability plane (device-plane precedent: the "
                     "harmony emulator's pasteboard answers honestly unavailable)"}
        for c in ["camera", "microphone", "bluetooth", "nfc"]
    ],
}
with open(f"{art}/capability-skips.json", "w") as f:
    json.dump(doc, f, indent=2); f.write("\n")
PY
    [ -f "$art/capability-skips.json" ] || mx_die "the capability-skips.json writer lied (file absent) — refusing to record"
}

ios_platform() {
    mx "=== iOS matrix (dsh-iphone / iOS 26.5) ==="
    command -v xcodebuild >/dev/null || mx_die "xcodebuild not on PATH"
    xcrun simctl list devices available | grep -q "$IOS_UDID" \
        || mx_die "simulator $IOS_UDID not available (DSH_E2E_UDID?)"
    ios_boot
    materialize
    ios_generate
    DSH_MATRIX_ENGINE_PIN=$(engine_pin)
    export DSH_MATRIX_ENGINE_PIN
    DSH_MATRIX_TREE=$(tree_line)
    export DSH_MATRIX_TREE
    if [ "${SKIP_RELEASE:-0}" -ne 1 ]; then
        leg_or_stop ios release ios_release_leg
    fi
    if [ "${SKIP_HARNESS:-0}" -ne 1 ]; then
        leg_or_stop ios harness ios_harness_leg
    fi
    # ONE capability-skips write per run, from a FRESH probe here — never a
    # hardcoded assertion of what the legs did (the first landing wrote
    # "idb present; legs ran" unconditionally, overwriting the honest
    # present:no record the no-driver path had just laid down — review
    # finding; a skip receipt must never be edited into a fake pass).
    if ios_idb_present; then
        if [ "${SKIP_HARNESS:-0}" -eq 1 ]; then
            ios_capability_skips yes "idb present; harness legs skipped by flag (--skip-harness)"
        else
            ios_capability_skips yes "idb present; the UI-driven harness legs ran"
        fi
    else
        ios_capability_skips no "idb missing or does not list $IOS_UDID"
    fi
}

# ---- Android ----------------------------------------------------------------

and_m() { echo "hosts/android/artifacts/simulator-matrix"; }

adb_of() { adb -s "$ADB_SERIAL" "$@"; }

# android_booted — the boot condition as a FUNCTION: poll_until re-executes
# its arguments each cycle, so an inline `[ "$(…)" = "1" ]` would freeze the
# command substitution at call time and poll a CONSTANT (measured: the stub
# flips state at 0.5s and the frozen shape still times out — review finding
# on the first landing). A function body re-evaluates every cycle.
android_booted() {
    [ "$(adb_of shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]
}

android_preflight() {
    command -v adb >/dev/null || mx_die "adb not found (ANDROID_HOME=$ANDROID_HOME)"
    if adb -s "$ADB_SERIAL" get-state >/dev/null 2>&1; then
        poll_until 600 android_booted \
            || mx_die "$ADB_SERIAL never finished booting (600s)"
        return 0
    fi
    # No emulator up: boot the AVD (conditional poll, never a blind wait),
    # loud when the process dies before completing boot.
    local emu="$ANDROID_HOME/emulator/emulator"
    [ -x "$emu" ] || mx_die "emulator binary missing at $emu"
    emulator -list-avds 2>/dev/null | grep -qx "$ANDROID_AVD" \
        || mx_die "AVD '$ANDROID_AVD' not found (have: $(emulator -list-avds 2>/dev/null | tr '\n' ' '))"
    mx "no emulator up — booting AVD $ANDROID_AVD (background, condition-polled)"
    ( "$emu" -avd "$ANDROID_AVD" -no-snapshot-save > /tmp/dsh-matrix-emulator.log 2>&1 & )
    poll_until 600 adb -s "$ADB_SERIAL" get-state \
        || mx_die "emulator $ADB_SERIAL never appeared within 600s (see /tmp/dsh-matrix-emulator.log)"
    poll_until 300 android_booted \
        || mx_die "emulator $ADB_SERIAL never finished booting (300s)"
}

android_release_leg() {
    local art="hosts/android/artifacts/simulator-matrix/release"
    CURRENT_ART="$art"
    mkdir -p "$art"
    local bt="${DSH_BUILD_TOOLS:-$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1)}"
    [ -x "$bt/apksigner" ] || mx_die "apksigner missing under $bt"
    local apk="hosts/android/app/build/outputs/apk/release/app-release-unsigned.apk"

    mx "release leg: gradlew assembleRelease"
    ( cd hosts/android && ./gradlew assembleRelease --no-daemon --console=plain 2>&1 | tail -3 ) \
        || mx_die "gradle assembleRelease failed"
    [ -f "$apk" ] || mx_die "release APK missing: $apk"
    # Read the listing ONCE, grep the FILE: `unzip -l | grep -q` lets grep exit
    # the pipeline early, SIGPIPE kills unzip, and pipefail then fails a check
    # that SUCCEEDED — the exact trap the committed release-logging runner
    # documents ("one listing, read twice"); stepped into here, fixed the same way.
    unzip -l "$apk" > "$art/apk-release-listing.txt"
    grep -q "assets/official-web/dist/index.html" "$art/apk-release-listing.txt" \
        || mx_die "the release APK embeds no official dist"
    grep -q "assets/dsh/logger.js" "$art/apk-release-listing.txt" \
        || mx_die "the release APK embeds no spike bundle"

    # The shipped artifact is unsigned (release.yml uploads it that way); the
    # emulator only takes signed APKs, so a COPY is signed with the debug
    # keystore — local verification only, never the shipped artifact's state.
    local verify="${DSH_MATRIX_VERIFY_DIR:-/tmp/dsh-sim-matrix-release-verify}"
    mkdir -p "$verify"
    local signed="$verify/app-release-verify-signed.apk"
    "$bt/apksigner" sign --ks "$HOME/.android/debug.keystore" \
        --ks-pass pass:android --key-pass pass:android \
        --ks-key-alias androiddebugkey --out "$signed" "$apk" \
        || mx_die "debug-keystore signing of the verification copy failed"

    adb_of shell am force-stop "$ANDROID_PKG" >/dev/null 2>&1 || true
    adb_of uninstall "$ANDROID_PKG" >/dev/null 2>&1 || true
    adb_of install -r "$signed" >/dev/null 2>&1 || mx_die "install of the signed release copy failed"
    adb_of logcat -c || mx_die "logcat -c failed (the absence assertions need a clean window)"
    adb_of shell am start -n "$ANDROID_PKG/.MainActivity" >/dev/null || mx_die "am start failed"

    # Conditions, not clocks: pid -> a uid SELF-CONNECTION (the WebView fetched
    # the loopback carrier) -> the seat answering.
    poll_until 90 adb_of shell pidof "$ANDROID_PKG" || mx_die "the release app process never came up"
    local uid
    uid="$(adb_of shell "stat -c %u /proc/$(adb_of shell pidof "$ANDROID_PKG" | tr -d '\r')" | tr -d '\r')"
    # The carrier = a LISTEN socket of the uid that the uid itself connected to
    # (the WebView's fetch). Finding the listener FIRST (`head -1`) loses to a
    # second listener: measured 2026-09-30, the plain release launch also keeps
    # the carrier on a tcp6 v4-mapped row while the first LISTEN row may be an
    # internal WebView port — the fetch check then waits on the wrong port and
    # starves. The self-connection predicate has no "which listener" question:
    # any non-LISTEN row whose REMOTE port is one of the uid's own LISTEN ports
    # is the page's live connection to the carrier, and names the carrier port.
    carrier_fetch() { # -> "HEXPORT NCONNECTIONS"; exit 3 while not yet fetched
        adb_of shell "cat /proc/net/tcp /proc/net/tcp6" 2>/dev/null | awk -v u="$uid" '
            $8==u {
                if ($4=="0A") listen[substr($2, index($2,":")+1)]++
                else est[substr($3, index($3,":")+1)]++
            }
            END {
                found=0
                for (p in listen) if (p in est) { print p, est[p]; found=1 }
                exit(found ? 0 : 3)
            }'
    }
    local deadline=$((SECONDS + 90)) port_and_n port nfetch
    until port_and_n="$(carrier_fetch)"; do
        [ "$SECONDS" -lt "$deadline" ] || mx_die "the WebView never fetched the carrier origin (no uid self-connection in the socket tables)"
        sleep 3
    done
    port="${port_and_n%% *}"; nfetch="${port_and_n#* }"
    adb_of forward "tcp:48045" "tcp:$((16#$port))" >/dev/null
    local probe; probe="$(curl -s -o /dev/null -w 'status=%{http_code}' http://127.0.0.1:48045/ || true)"
    adb_of forward --remove tcp:48045 >/dev/null 2>&1 || true
    [ "$probe" = "status=401" ] || mx_die "the dist seat answered $probe, not the 401 auth-lite gate"

    {
        echo "# the release boot's served origin, probed through adb forward"
        echo "carrier_port=$((16#$port)) uid=$uid page_connections_to_carrier=$nfetch"
        echo "GET / -> $probe   (401 = the auth-lite token gate of the official dist seat)"
        echo "launcher focus: $(adb_of shell dumpsys window 2>/dev/null | grep -m1 mCurrentFocus | tr -d '\r')"
    } > "$art/origin-release.txt"
    adb_of exec-out screencap -p > "$art/plain-launch-release.png"
    png_valid "$art/plain-launch-release.png" || mx_die "release screenshot is not a valid PNG"
    adb_of logcat -d -s dsh.spike dsh.spike.result > "$art/plain-launch-release.logcat.txt" 2>&1 || true
    adb_of logcat -d --pid="$(adb_of shell pidof "$ANDROID_PKG" | tr -d '\r')" \
        > "$art/plain-launch-release.app.logcat.txt" 2>&1 || true

    local f
    for f in "$art/plain-launch-release.logcat.txt" "$art/plain-launch-release.app.logcat.txt"; do
        for pat in 'dsh.spike.result' 'ALL PASS' 'ALL FAIL' '"level":"debug"' '"level":"info"'; do
            [ "$(count_of "$f" "$pat")" -eq 0 ] || mx_die "release emitted drive machinery '$pat' in $f — the flavor split regressed"
        done
    done
    local audit_n=0 warn_n=0
    for f in "$art/plain-launch-release.logcat.txt" "$art/plain-launch-release.app.logcat.txt"; do
        audit_n=$((audit_n + $(count_of "$f" 'dsh.gateway.audit:')))
        warn_n=$((warn_n + $(count_of "$f" '"level":"warn"')))
    done
    adb_of shell run-as "$ANDROID_PKG" ls files >/dev/null 2>&1 \
        && mx_die "the release build is debuggable (run-as works) — it must not be"

    # The refusal (rule 5): a drive asked by extra is refused BY NAME.
    adb_of shell am force-stop "$ANDROID_PKG" >/dev/null 2>&1 || true
    adb_of logcat -c || mx_die "logcat -c failed before the refusal probe"
    adb_of shell am start -n "$ANDROID_PKG/.MainActivity" --ez dsh.llm true >/dev/null \
        || mx_die "am start with the drive extra failed to dispatch"
    deadline=$((SECONDS + 60))
    until adb_of logcat -d 2>/dev/null | grep -q "release build: refusing"; do
        [ "$SECONDS" -lt "$deadline" ] || mx_die "the release build did not refuse the dsh.llm drive within 60s"
        sleep 2
    done
    adb_of logcat -d > "$art/refusal.logcat.txt" 2>&1 || true
    grep -q "release build: refusing 'dsh.llm'" "$art/refusal.logcat.txt" \
        || mx_die "the refusal does not name the offending drive"

    python3 - "$art" "$ADB_SERIAL" "$audit_n" "$warn_n" <<'PY'
import json, os, sys
from datetime import datetime
art, serial = sys.argv[1], sys.argv[2]
audit_n, warn_n = int(sys.argv[3]), int(sys.argv[4])
proof = {
    "leg": "release",
    "configuration": "Release (the user-facing distribution build; debug-keystore verification copy)",
    "host": f"android {serial}",
    "engine": "quickjs-ng",
    "engineVersion": os.environ.get("DSH_MATRIX_ENGINE_PIN", ""),
    "tree": os.environ.get("DSH_MATRIX_TREE", ""),
    "assertions": {
        "driveMachineryMarkers": 0,
        "assertedZero": ["dsh.spike.result", "ALL PASS", "ALL FAIL",
                          "level:debug records", "level:info records", "debuggable"],
        "officialUiReached": "carrier LISTEN + page fetch + GET / -> 401 (origin-release.txt); plain-launch-release.png",
        "driveRefusal": "refusal.logcat.txt — refusing 'dsh.llm' by name",
    },
    "observedNotAsserted": {
        "gatewayAuditLines": audit_n,
        "warnLevelRecords": warn_n,
        "note": "the product's own planes on today's serving boot — recorded as fact, "
                "never asserted zero (see the surprise ledger: the committed "
                "release-logging 0/0 assertions are stale against this tree)",
    },
    "producedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
}
with open(os.path.join(art, "release-proof.json"), "w") as f:
    json.dump(proof, f, indent=2); f.write("\n")
PY
    [ -f "$art/release-proof.json" ] || mx_die "the release-proof.json writer lied (file absent) — refusing to record"
    record android release PASS "0 drive markers / 0 debug+info; audit=$audit_n warn=$warn_n (product planes, recorded); refusal by name; proof in $art/release-proof.json"
}

android_regression_leg() {
    local art="hosts/android/artifacts/simulator-matrix/regression"
    mkdir -p "$art/screens"
    mx "harness regression: gradlew assembleDebug + run-spike-e2e.sh"
    ( cd hosts/android && ./gradlew assembleDebug --no-daemon --console=plain 2>&1 | tail -2 ) \
        || mx_die "gradle assembleDebug failed"
    hosts/android/ci/run-spike-e2e.sh || { record android regression FAIL "run-spike-e2e.sh exited non-zero"; return 1; }

    # The runner captures to /tmp (its own CI contract); the matrix assembles
    # the committed evidence dir around it — the same shape as the committed
    # m1/m4 legs (logs.txt, scenario.jsonl, verdict-*.json, receipt.json).
    cp /tmp/dsh-spike-logs.txt "$art/logs.txt" \
        || mx_die "run-spike-e2e.sh left no /tmp/dsh-spike-logs.txt — nothing to evidence"
    grep 'dsh.spike.log:' "$art/logs.txt" > "$art/scenario.jsonl" || true
    cp /tmp/dsh-spike-verdict-m1.json      "$art/verdict-boot-verification.json" \
        || mx_die "the boot verdict capture is missing"
    cp /tmp/dsh-spike-verdict-m2.json      "$art/verdict-gateway-bridge-smoke.json" \
        || mx_die "the bridge-smoke verdict capture is missing"
    cp /tmp/dsh-spike-verdict-session.json "$art/verdict-session-mock-llm.json" \
        || mx_die "the session verdict capture is missing"
    adb_of exec-out screencap -p > "$art/screens/final.png"
    png_valid "$art/screens/final.png" || mx_die "regression screenshot is not a valid PNG"

    python3 - "$art" "$ADB_SERIAL" <<'PY'
import json, os, subprocess, sys
from datetime import datetime
art, serial = sys.argv[1:3]
scenarios = []
for stem, manifest in [("boot-verification", "boot-verification"),
                       ("gateway-bridge-smoke", "gateway-bridge-smoke"),
                       ("session-mock-llm", "session-mock-llm")]:
    v = json.load(open(f"{art}/verdict-{stem}.json"))
    scenarios.append({"manifest": manifest, "verdict": f"verdict-{stem}.json",
                      "id": v["scenario"], "pass": bool(v["pass"])})
receipt = {
    "host": f"android {serial}",
    "runner": "hosts/android/ci/run-spike-e2e.sh (assembled by tools/test/run-simulator-matrix.sh)",
    "phase": "three-scenario regression (boot.verification + gateway.bridge-smoke + session.mock-llm)",
    "launch": "emulator, plain am start (Debug harness)",
    "tree": os.environ.get("DSH_MATRIX_TREE", ""),
    "engine": os.environ.get("DSH_MATRIX_ENGINE_PIN", ""),
    "scenarios": scenarios,
    "screens": ["screens/final.png"],
    "producedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
}
with open(f"{art}/receipt.json", "w") as f:
    json.dump(receipt, f, indent=2); f.write("\n")
PY
    [ -f "$art/receipt.json" ] || mx_die "the receipt.json writer lied (file absent) — refusing to record"
    record android regression PASS "3 verdicts green + receipt ($art)"
}

android_device_plane_leg() {
    local art="hosts/android/artifacts/simulator-matrix/device-plane"
    mx "harness device-plane: run-device-plane.sh (the v1.5.0 capability ladder)"
    DSH_ANDROID_ART="$art" hosts/android/ci/run-device-plane.sh --skip-build \
        || { archive_failed_dir android device-plane; record android device-plane FAIL "run-device-plane.sh exited non-zero — dir moved to /tmp"; return 1; }
    record android device-plane PASS "device.plane + audit verdicts green + receipt ($art)"
}

android_capability_skips() {
    local art; art="$(and_m)"
    mkdir -p "$art"
    local uia
    uia="$(adb_of shell which uiautomator 2>/dev/null | tr -d '\r')"
    python3 - "$art" "$ADB_SERIAL" "$uia" <<'PY'
import json, sys
from datetime import datetime
art, serial, uia = sys.argv[1:4]
doc = {
    "platform": "android",
    "target": serial,
    "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
    "probed": [
        {"driver": "uiautomator", "present": bool(uia), "path": uia,
         "note": "the emulator's own UI automator drives the native surfaces; no leg skipped"},
    ],
    "hardware": [
        {"capability": c, "status": "no-emulator-hardware",
         "baseline": "an emulator exposes no camera/BT/NFC radio; when the system "
                     "capability face lands, its scenarios negotiate `unavailable` "
                     "through the capability plane (device-plane precedent: the "
                     "harmony emulator's pasteboard answers honestly unavailable)"}
        for c in ["camera", "microphone", "bluetooth", "nfc"]
    ],
}
with open(f"{art}/capability-skips.json", "w") as f:
    json.dump(doc, f, indent=2); f.write("\n")
PY
    [ -f "$art/capability-skips.json" ] || mx_die "the capability-skips.json writer lied (file absent) — refusing to record"
}

android_platform() {
    mx "=== Android matrix (AVD $ANDROID_AVD / $ADB_SERIAL) ==="
    android_preflight
    materialize
    DSH_MATRIX_ENGINE_PIN=$(engine_pin)
    export DSH_MATRIX_ENGINE_PIN
    DSH_MATRIX_TREE=$(tree_line)
    export DSH_MATRIX_TREE
    if [ "${SKIP_RELEASE:-0}" -ne 1 ]; then
        leg_or_stop android release android_release_leg
    fi
    if [ "${SKIP_HARNESS:-0}" -ne 1 ]; then
        leg_or_stop android regression android_regression_leg
        leg_or_stop android device-plane android_device_plane_leg
    fi
    android_capability_skips
}

# ---- Harmony ----------------------------------------------------------------

harmony_platform() {
    mx "=== HarmonyOS matrix (honest skip unless a toolchain + target exist) ==="
    local hdc="/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools/sdk/default/openharmony/toolchains/hdc"
    local art="hosts/harmony/artifacts/simulator-matrix"
    mkdir -p "$art"
    local deveco=0 targets="unavailable" real_target=no
    [ -d "/Applications/DevEco-Studio.app" ] && deveco=1
    if [ -x "$hdc" ]; then
        # Join with "; " but STRIP the trailing separator before any
        # comparison: `tr '\n' ';'` yields "[Empty];", which compares
        # unequal to "[Empty]" forever (review finding — the guard then
        # treats an EMPTY list as a target present, or a real target is
        # masked by the deveco=0 short-circuit and the receipt contradicts
        # its own probes field).
        targets="$("$hdc" list targets 2>&1 | tr -d '\r' | tr '\n' ';')"
        targets="${targets%;}"
        [ -n "$targets" ] || targets="(no output)"
        # The REAL-target question is decoupled from DevEco's presence: any
        # hdc line other than the empty-list marker is a live target.
        local line
        while IFS= read -r line; do
            [ -n "$line" ] || continue
            [ "$line" = "[Empty]" ] || { real_target=yes; break; }
        done <<< "$(printf '%s' "$targets" | tr ';' '\n')"
    fi
    if [ "$real_target" = yes ]; then
        mx_die "a harmony target IS present ($targets) — wire the real leg (hosts/harmony/ci/run-host-e2e.sh) instead of skipping; this script only skips honestly"
    fi
    local reason
    if [ "$deveco" -eq 1 ]; then
        reason="no hdc simulator target on this machine (DevEco IS present, but nothing is booted) — the leg stays script-ready (D-g): hosts/harmony/ci/run-host-e2e.sh runs it when a device exists. Never faked: a skip receipt, not a green one."
    else
        reason="no DevEco toolchain and no hdc simulator target on this machine — the leg stays script-ready (D-g): hosts/harmony/ci/run-host-e2e.sh runs it when a device exists. Never faked: a skip receipt, not a green one."
    fi
    python3 - "$art" "$deveco" "$targets" "$reason" "$(tree_line)" <<'PY'
import json, sys
from datetime import datetime
art, deveco, targets, reason = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
skip = {
    "platform": "harmonyos",
    "status": "skipped",
    "leg": "simulator e2e (the harmony ladder)",
    "reason": reason,
    "probes": {"DevEco-Studio.app present": bool(deveco), "hdc list targets": targets},
    "tree": sys.argv[5] if len(sys.argv) > 5 else "",
    "producedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
}
with open(f"{art}/matrix-skip-receipt.json", "w") as f:
    json.dump(skip, f, indent=2); f.write("\n")
PY
    [ -f "$art/matrix-skip-receipt.json" ] || mx_die "the matrix-skip-receipt.json writer lied (file absent) — refusing to record"
    record harmony platform SKIP "no live hdc target — matrix-skip-receipt.json written (D-g standby)"
}

# ---- orchestration ----------------------------------------------------------

# A FAILED harness leg leaves a half-evidenced dir on disk (verdicts without
# a receipt — the runner emits receipts on its green path only). The
# e2e-matrix gate walks the working tree and would flag exactly that dir as
# a NEW finding, red on every later `gov run` — so a failed leg's dir moves
# to /tmp for diagnosis and the tree stays gate-clean.
archive_failed_dir() { # PLATFORM LEG
    local dir="hosts/$1/artifacts/simulator-matrix/$2"
    [ -d "$dir" ] || return 0
    [ -n "$(ls -A "$dir" 2>/dev/null)" ] || { rmdir "$dir"; return 0; }
    local keep="/tmp/dsh-matrix-failed-$1-$2"
    rm -rf "$keep"
    mv "$dir" "$keep"
    echo "matrix: ($1/$2 evidence moved to $keep for diagnosis — a failed leg's dir must not sit in the gate's inventory)" >&2
}

leg_or_stop() { # PLATFORM LEG NAME FN — fail fast unless KEEP_GOING
    local plat="$1" leg="$2" fn="$3"
    if ! "$fn"; then
        OVERALL=1
        grep -q "|$leg|FAIL|" "$STATE" || record "$plat" "$leg" FAIL "leg function returned non-zero"
        archive_failed_dir "$plat" "$leg"
        [ "$KEEP_GOING" = "1" ] || mx_die "$plat/$leg failed — stopping (DSH_MATRIX_KEEP_GOING=1 to run every leg anyway)"
    fi
}

summary() {
    echo
    echo "==================== simulator matrix summary ===================="
    printf '%-10s %-14s %-8s %s\n' PLATFORM LEG STATUS DETAIL
    while IFS='|' read -r p l s d; do
        printf '%-10s %-14s %-8s %s\n' "$p" "$l" "$s" "$d"
    done < "$STATE"
    echo "==================================================================="
    if [ "$OVERALL" -eq 0 ]; then mx "matrix GREEN"; else mx "matrix RED"; fi
    return "$OVERALL"
}

main() {
    # The no-argument default IS `all`: the default used to be the literal
    # three-word list, which the validation case below rejects (only `all` or
    # one platform word passes) — a bare `run-simulator-matrix.sh` died
    # "unknown --platform value: ios android harmony" before booting anything
    # (found by the v0.0.2 release regression's final run, 2026-09-30; every
    # earlier run had passed --platform explicitly, so the default was never
    # exercised).
    local platforms="all"
    while [ $# -gt 0 ]; do
        case "$1" in
            --platform) platforms="$2"; shift 2 ;;
            --skip-release) SKIP_RELEASE=1; shift ;;
            --skip-harness) SKIP_HARNESS=1; shift ;;
            *) mx_die "usage: run-simulator-matrix.sh [--platform ios|android|harmony|all] [--skip-release] [--skip-harness]" ;;
        esac
    done
    case "$platforms" in
        all) platforms="ios android harmony" ;;
        ios|android|harmony) ;;
        *) mx_die "unknown --platform value: $platforms" ;;
    esac
    local p
    for p in $platforms; do
        case "$p" in
            ios)     ios_platform || OVERALL=1 ;;
            android) android_platform || OVERALL=1 ;;
            harmony) harmony_platform || OVERALL=1 ;;
        esac
    done
    summary
}

main "$@"
