#!/bin/sh
# run.sh — the HarmonyOS half of the release-logging evidence: prove that the
# user-facing build SERVES the official DSH Web UI with no verification
# machinery at all, that it still refuses an E2E drive LOUD by name, and that
# the harness is unchanged.
#
# Release (dsh-harmony): a plain launch — NO `--ps dsh.e2e.leg` parameter,
# nothing staged into the app container — must reach the official DSH Web UI
# from the vendored rawfile trees, emit ZERO `dsh.spike.log:` records, ZERO
# verdict text and ZERO `"level":"debug"`/`"level":"info"` records in the
# whole hilog window (and in the truncation-proof capture file); asking the
# same binary for `--ps dsh.e2e.leg m2.llm` must refuse by name.
# Debug (dsh-harmony-harness): the plain launch still runs the full default
# chain, and the whole E2E suite must stay green (the same eight checker
# verdicts as hosts/harmony/artifacts/d9-*).
#
# Every wait is a polled condition with a deadline (rules.md rule 8); every
# exhaustion is loud (rule 5). The zero-record assertions run over the FULL
# hilog window; the committed `.dsh.txt` files are that window's `dsh`-tag
# lines (milestone-artifact convention, cf. artifacts/m5-host/logs.txt).
#
# usage: hosts/harmony/artifacts/release-logging/run.sh [--skip-build]
set -eu

ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
CLT=${DSH_CLT:-/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools}
HDC="$CLT/sdk/default/openharmony/toolchains/hdc"
ART="$ROOT/hosts/harmony/artifacts/release-logging"
BUNDLE=com.dshmobile.spike
HAP=hosts/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap
REL_HAP=/tmp/dsh-harmony-release.hap
DBG_HAP=/tmp/dsh-harmony-harness.hap
BASE=/data/app/el2/100/base/$BUNDLE/haps/entry/cache
RECORDS='dsh.spike.log:'
SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

log() { echo "release-logging(harmony): $*"; }
die() { echo "release-logging(harmony): FAIL: $*" >&2; exit 1; }
count() { grep -c -F "$2" "$1" 2>/dev/null || true; }

# ---- build both configurations --------------------------------------------------

if [ "$SKIP_BUILD" -eq 0 ]; then
    log "vendoring + building BOTH configurations (release, debug)"
    hosts/harmony/ci/vendor-official.sh >/dev/null
    (cd hosts/harmony && "$CLT/bin/ohpm" install --all >/dev/null)
    for mode in release debug; do
        # THE NATIVE TRAP: hvigor's buildMode does NOT enter the native output
        # path — BOTH modes' ninja trees link to the SAME
        # entry/build/default/intermediates/cmake/default/obj/arm64-v8a/libspike.so,
        # so the second mode's ninja finds the first mode's .so "up to date"
        # ("ninja: no work to do" in .cxx/.../<mode>/output.log) and the HAP
        # packs the OTHER configuration's native library (observed: the debug
        # HAP carrying the release .so, i.e. a log-stripped harness whose
        # captures came out empty). Clean both trees before each mode so each
        # HAP is built from its own configuration — verified by the counts
        # this script asserts below (surprise ledger: harmony-native-cross-mode).
        rm -rf hosts/harmony/entry/build hosts/harmony/entry/.cxx
        (cd hosts/harmony && "$CLT/bin/hvigorw" assembleHap --mode module \
            -p product=default -p buildMode=$mode --no-daemon) \
            > /tmp/dsh-hap-$mode.log 2>&1 \
            || die "hvigorw $mode build failed — see /tmp/dsh-hap-$mode.log"
        [ -f "$HAP" ] || die "hvigorw $mode produced no HAP"
        if [ "$mode" = "release" ]; then
            cp "$HAP" "$REL_HAP"
            log "built release HAP -> $REL_HAP"
        else
            cp "$HAP" "$DBG_HAP"
            log "built debug HAP -> $DBG_HAP"
        fi
    done
fi
[ -f "$REL_HAP" ] || die "release HAP missing ($REL_HAP — build first or unset --skip-build)"
[ -f "$DBG_HAP" ] || die "debug HAP missing ($DBG_HAP — build first or unset --skip-build)"

mkdir -p "$ART"

# ---- the emulator, installs, launches -------------------------------------------

deadline=$(( $(date +%s) + 120 ))
until "$HDC" list targets | grep -q 127.0.0.1; do
    [ "$(date +%s)" -lt "$deadline" ] \
        || die "no emulator target within 120s (start dsh_phone first)"
    sleep 2
done

# hilog flow control drops the canonical record stream under burst (the
# harness suite asserts on it; see ci/run-host-e2e.sh). This script's release
# verdicts are ABSENCES read off the same buffer, so a dropped burst could
# hide a record — hiding a record is exactly what this script exists to rule
# out. Asserted, not just set: a delivery knob that silently stayed on would
# make the zeros below lie.
for knob in pidoff domainoff; do
    out=$("$HDC" shell hilog -Q "$knob" 2>&1 || true)
    case "$out" in
        *successfully*) ;;
        *) die "hilog -Q $knob failed ($out) — the record stream can be dropped, so a zero-record result would prove nothing" ;;
    esac
done

install_hap() { # $1 = hap path
    tries=0
    until "$HDC" install -r "$1" >/dev/null 2>&1; do
        tries=$(( tries + 1 ))
        [ "$tries" -lt 5 ] || die "hdc install kept failing: $1"
        sleep 2
    done
}

# One clean window per launch: wake+unlock, force-stop VERIFIED, hilog cleared,
# then `aa start` retried until the process exists (aa start's exit code is not
# evidence — the waited-for condition is the PID; rule 8).
launch() { # $1 = extra launch parameters ('' for the plain launch)
    "$HDC" shell power-shell wakeup >/dev/null 2>&1 || true
    "$HDC" shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
    "$HDC" shell aa force-stop $BUNDLE >/dev/null 2>&1 || true
    if [ -n "$("$HDC" shell pidof $BUNDLE 2>/dev/null | tr -d '[:space:]')" ]; then
        die "aa force-stop left $BUNDLE resident (pidof non-empty)"
    fi
    "$HDC" shell hilog -r >/dev/null
    deadline=$(( $(date +%s) + 120 ))
    until [ -n "$("$HDC" shell pidof $BUNDLE 2>/dev/null | tr -d '[:space:]')" ]; do
        [ "$(date +%s)" -lt "$deadline" ] \
            || die "$BUNDLE process never appeared within 120s of aa start"
        "$HDC" shell power-shell wakeup >/dev/null 2>&1 || true
        "$HDC" shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
        # shellcheck disable=SC2086 — the parameters are a fixed literal here
        "$HDC" shell aa start -b $BUNDLE -a EntryAbility $1 >/dev/null 2>&1 || true
        sleep 3
    done
}

# Poll the hilog window for one fixed string; fail loud on the deadline (rule 8).
await_log() { # $1 = fixed string, $2 = what it proves, $3 = deadline seconds
    deadline=$(( $(date +%s) + $3 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        "$HDC" shell hilog -x > "$WINDOW" 2>/dev/null
        if grep -q -F "$1" "$WINDOW"; then
            return 0
        fi
        sleep 3
    done
    die "$2: '$1' never appeared in the hilog window within $3s"
}

snapshot() { # $1 = destination .png
    "$HDC" shell snapshot_display -f /data/local/tmp/dsh-release-logging.jpeg >/dev/null
    "$HDC" file recv /data/local/tmp/dsh-release-logging.jpeg /tmp/dsh-release-logging.jpeg >/dev/null
    # snapshot_display emits JPEG; a .png name must carry PNG bytes (macOS sips).
    sips -s format png /tmp/dsh-release-logging.jpeg --out "$1" >/dev/null
}

# ---- 1/3: dsh-harmony (release), plain launch, nothing staged --------------------

WINDOW=/tmp/dsh-harmony-release-window.txt
log "1/3 install dsh-harmony (release) + plain launch (no leg parameter)"
install_hap "$REL_HAP"
launch ''
# The official UI is up when the origin was served to ArkWeb, the app's remote
# mux seat opened (the client module system is live), and the clean index
# finished loading. Three serving facts, each a polled condition.
await_log "arkweb: controller attached for http://127.0.0.1:17890/?token=" \
    "the release build never served the official origin" 150
await_log "carrier: ws established /api/remote.mux" \
    "the official app never opened its remote mux seat" 150
await_log "arkweb: page end http://127.0.0.1:17890/" \
    "the official index never finished loading" 150
sleep 5   # let the app shell paint before the screenshot
"$HDC" shell hilog -x > "$WINDOW" 2>/dev/null
snapshot "$ART/plain-launch-release.png"

"$HDC" file recv "$BASE/dsh-official-serve.log" "$ART/plain-launch-release.capture.txt" >/dev/null
[ -f "$ART/plain-launch-release.capture.txt" ] || die "no release capture file to pull"
grep 'com.dshmobile.spike/dsh' "$WINDOW" > "$ART/plain-launch-release.dsh.txt" || true
grep -F "$RECORDS" "$WINDOW" > "$ART/plain-launch-release.records.txt" || true

[ "$(count "$WINDOW" "$RECORDS")" -eq 0 ] \
    || die "release emitted a $RECORDS record (see .dsh.txt / the window)"
[ "$(count "$WINDOW" 'dsh.spike.verdict')" -eq 0 ] \
    || die "release emitted verdict text"
[ "$(count "$WINDOW" '"level":"debug"')" -eq 0 ] || die "release emitted a debug record"
[ "$(count "$WINDOW" '"level":"info"')" -eq 0 ] || die "release emitted an info record"
[ "$(count "$ART/plain-launch-release.capture.txt" "$RECORDS")" -eq 0 ] \
    || die "release wrote a $RECORDS record into the capture file"
[ "$(count "$ART/plain-launch-release.dsh.txt" "$RECORDS")" -eq 0 ] \
    || die "release emitted a record on its own tags"

# ---- 2/3: the refusal (rules.md rule 5) ------------------------------------------

log "2/3 dsh-harmony (release) asked for an E2E leg"
WINDOW=/tmp/dsh-harmony-refusal-window.txt
launch '--ps dsh.e2e.leg m2.llm'
REFUSAL='release build: refusing: dsh.e2e.leg m2.llm asks for a verification drive'
await_log "$REFUSAL" "the release build did not refuse an E2E leg" 60
sleep 3
"$HDC" shell hilog -x > "$WINDOW" 2>/dev/null
snapshot "$ART/refusal.png"
grep 'com.dshmobile.spike/dsh' "$WINDOW" > "$ART/refusal.dsh.txt" || true
grep -F "$RECORDS" "$WINDOW" > "$ART/refusal.records.txt" || true
grep -F "$REFUSAL" "$WINDOW" > "$ART/refusal.txt" || true
[ -s "$ART/refusal.txt" ] || die "the refusal line was not captured into refusal.txt"
[ "$(count "$WINDOW" "$RECORDS")" -eq 0 ] \
    || die "the refusing release build emitted a $RECORDS record"

# ---- 3/3: dsh-harmony-harness (debug) — unchanged --------------------------------

log "3/3 install dsh-harmony-harness (debug) + the full E2E suite"
install_hap "$DBG_HAP"
HARNESS_OUT=/tmp/dsh-harmony-harness-suite
rm -rf "$HARNESS_OUT"
if DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh "$HARNESS_OUT" \
        > /tmp/dsh-harmony-harness-suite.log 2>&1; then
    log "the harness suite is green"
else
    tail -30 /tmp/dsh-harmony-harness-suite.log >&2 || true
    die "the harness E2E suite regressed — see /tmp/dsh-harmony-harness-suite.log"
fi

HARNESS_RECORDS=0
for cap in sink-capture.txt binding-capture.txt official-capture.txt \
           httpfetch-capture.txt session-capture.txt write-capture.txt; do
    [ -f "$HARNESS_OUT/$cap" ] || die "the harness suite produced no $cap"
    n=$(count "$HARNESS_OUT/$cap" "$RECORDS")
    HARNESS_RECORDS=$(( HARNESS_RECORDS + n ))
done
[ "$HARNESS_RECORDS" -gt 0 ] \
    || die "the harness emitted no $RECORDS records — its evidence regressed"

{
    echo "# Harness contrast — dsh-harmony-harness (debug), the same host"
    echo
    echo "The SAME plain launch (no leg parameter) in the debug configuration runs"
    echo "the full default chain (regression trio -> m5 binding -> the four D9 legs)"
    echo "and emits the full structured stream. Re-run: DSH_SKIP_BUILD=1 \\"
    echo "hosts/harmony/ci/run-host-e2e.sh <dir> (this file's own run: see run.sh 3/3)."
    echo
    echo "records emitted (six capture files, in run order): $HARNESS_RECORDS"
    echo "release records in the same window: 0"
    echo
    echo "## Checker verdicts (tools/e2e/check.mjs, one manifest each)"
    for v in "$HARNESS_OUT"/verdict-*.json; do
        echo "  $(basename "$v" .json | sed 's/^verdict-//'): $(grep -o '"logged": [0-9]*' "$v" | head -1)"
    done
    echo
    grep -F 'run-host-e2e: PASS' /tmp/dsh-harmony-harness-suite.log || true
    echo
    echo "The committed per-leg evidence (captures, verdicts, screenshots) for the"
    echo "same suite lives in hosts/harmony/artifacts/d9-official-web/,"
    echo "d9-session-live/, d9-write-live/ and m5-host/ — this run must not change"
    echo "their outcomes."
} > "$ART/harness-contrast.txt"

log "release: 0 records / 0 verdict / 0 debug+info; harness: $HARNESS_RECORDS records, suite green"
log "artifacts in $ART"
