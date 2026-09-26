#!/bin/sh
# run-android-next-web-mount.sh — the SELF-HOSTED web clients on Android:
# the whale creation client on the v0 /ws session seat (android.whale.mount)
# and the next client on the official SessionServe seat (android.nextweb.mount
# — the full creation leg: prompt → streamed reply → stop → create → present
# → fullscreen viewer, all driven through the page's own composer).
#
# Evidence discipline: the canary-pinned, line-buffered logcat capture bounded
# at the first `dsh.spike.result: ALL` line (run-upstream-parity.sh's rule —
# stale completion tags from earlier steps cannot truncate the capture), one
# checker verdict per manifest, and a screenshot per leg (human evidence only
# — never a checker input). Every wait is a polled condition with a deadline
# (rules.md rule 8); every exhaustion is loud (rule 5).
set -eu

APK=hosts/android/app/build/outputs/apk/debug/app-debug.apk
PKG=com.dshmobile.spike
OUT=${DSH_NEXT_OUT:-hosts/android/artifacts/nextweb-mount}
SCEN=test/e2e/scenarios

say() { echo "run-android-next-web-mount: $*"; }
die() { echo "::error::run-android-next-web-mount: $*" >&2; exit 1; }

# ---- Build here, not "bring your own APK" (run-android-full.sh's rule: a
# stale pre-built APK silently re-proves a build that is no longer the tree).
say "building the APK (assembleDebug; no-ops when up to date)"
( cd hosts/android && ./gradlew :app:assembleDebug -q ) \
    || die "gradle :app:assembleDebug failed — set ANDROID_HOME if the SDK is missing"
[ -f "$APK" ] || die "build produced no APK at $APK"

deadline=$(( $(date +%s) + 600 ))
until adb get-state >/dev/null 2>&1 &&
      [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    [ "$(date +%s)" -ge "$deadline" ] && die "emulator not booted within 600s"
    sleep 5
done

adb install -r "$APK" >/dev/null || die "adb install failed"
mkdir -p "$OUT"

# ---- one leg: canary-pinned capture → drive → truncate → checker ------------
#
# $1 leg tag, $2 launch extra, $3 the scenario's own completion evidence (the
# completion tag alone cannot be trusted — stale tags pierce logcat -c),
# $4 manifest file, $5 the artifact dir (carries logs.txt/scenario.jsonl/
# verdict-*.json), $6 screenshot name.
run_leg() {
    leg=$1; extra=$2; evidence=$3; manifest=$4; out=$5; shot_name=$6
    stream="$out/$leg-stream.txt"
    mkdir -p "$out"
    say "leg $leg: launching with --ez $extra true"
    adb shell am force-stop $PKG >/dev/null 2>&1 || true
    adb logcat -c
    : > "$stream"
    # Line-buffered stream (stdio block buffering would starve the greps) +
    # canary pin (the clear races the reader's initial snapshot).
    canary="dsh-begin-$$-$leg"
    adb logcat -s dsh.spike dsh.spike.result dsh.canary > "$stream" 2>/dev/null &
    streamer=$!
    cleanup() {
        kill "$streamer" 2>/dev/null || true
        pkill -f "logcat -s dsh.spike" 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM
    adb shell log -t dsh.canary "$canary" >/dev/null
    dline=$(( $(date +%s) + 60 ))
    until grep -q "$canary" "$stream"; do
        [ "$(date +%s)" -ge "$dline" ] && die "$leg: logcat streamer never attached (canary unseen within 60s)"
        sleep 0.2
    done

    dline=$(( $(date +%s) + 60 ))
    until adb shell am start -n $PKG/.MainActivity --ez "$extra" true >/dev/null 2>&1; do
        [ "$(date +%s)" -ge "$dline" ] && die "$leg: am start kept failing within 60s"
        sleep 2
    done

    # Both conditions: the scenario's own evidence (stale completion tags
    # cannot fake it) and the completion tag itself.
    dline=$(( $(date +%s) + 330 ))
    until grep -q "$evidence" "$stream" && grep -q "dsh.spike.result: ALL" "$stream"; do
        if [ "$(date +%s)" -ge "$dline" ]; then
            tail -80 "$stream" >&2
            die "$leg: scenario did not complete within 330s"
        fi
        sleep 0.5
    done
    sleep 0.3 # let the completion-tag line itself flush
    trap - EXIT
    cleanup

    adb exec-out screencap -p > "$out/$shot_name" 2>/dev/null || true
    awk -v c="$canary" 'index($0, c) {seen=1} seen' "$stream" \
        | sed '/dsh.spike.result: ALL/q' > "$out/logs.txt"
    grep 'dsh.spike.log:' "$out/logs.txt" > "$out/scenario.jsonl" || true
    rm -f "$stream"

    node test/e2e/check.mjs --manifest "$SCEN/$manifest" \
        --log "$out/logs.txt" --out "$out/verdict-${manifest%.json}.json"
    cat "$out/verdict-${manifest%.json}.json"
    say "leg $leg complete — evidence under $out"
}

run_leg whale dsh.whale "ws.session-complete" android-whale-mount.json \
    hosts/android/artifacts/whale-mount 01-whale-mounted.png
run_leg next dsh.next "creation.opened" android-nextweb-mount.json \
    hosts/android/artifacts/nextweb-mount 02-creation-viewer.png

say "both legs green — evidence under hosts/android/artifacts/{whale,next}web-mount"
