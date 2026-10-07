#!/bin/sh
# run-dsh-e2e.sh — one invocation drives the whole on-emulator E2E:
# boot wait -> install -> launch -> deadline poll -> capture -> checker verdict.
#
# Why a single script driving the emulator directly: android-emulator-runner
# proved hostile twice — it executes its `script:` one `sh -c` PER LINE (a
# multi-line `until` loop split mid-syntax and died), and its built-in
# disable-animations pass failed broken-pipe seconds after sys.boot_completed.
# Here every wait is a polled condition with a deadline (rules.md rule 8 —
# sleeps only pace polling) and every exhaustion is loud (rule 5).
set -eu

CAPTURE="$(cd "$(dirname "$0")" && pwd)/logcat-capture.sh"
APK=hosts/android/app/build/outputs/apk/debug/app-debug.apk

# KVM is a hard precondition on Linux runners: without it the emulator
# process dies at once and every adb wait below would hang. Fail in
# seconds, not at the job timeout.
if [ "$(uname)" = "Linux" ] && [ ! -w /dev/kvm ]; then
    echo "::error::/dev/kvm missing or not writable — KVM acceleration unavailable"
    ls -la /dev/kvm 2>&1 || true
    exit 1
fi

# Device presence AND boot completion, one bounded poll (rule 8). The bare
# `adb wait-for-device` this replaces has NO deadline: when the emulator
# process dies at spawn (the observed 30+ min CI hang), it would block
# forever. So liveness is polled alongside the boot property.
deadline=$(( $(date +%s) + 600 ))
until adb get-state >/dev/null 2>&1 &&
      [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    if ! pgrep -f "emulator" >/dev/null 2>&1; then
        echo "::error::emulator process is gone — boot never started or died"
        tail -100 /tmp/emulator.log || true
        exit 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "::error::emulator did not finish booting within 600s"
        tail -100 /tmp/emulator.log || true
        exit 1
    fi
    sleep 5
done

# system_server may still be settling right after boot_completed (the CI
# broken-pipe evidence); retry transient install failures, loudly.
tries=0
until adb install -r "$APK"; do
    tries=$(( tries + 1 ))
    if [ "$tries" -ge 5 ]; then
        echo "::error::adb install kept failing after boot"
        exit 1
    fi
    sleep 3
done

# Launch exactly ONCE and STREAM the log to a file, then bound the capture
# at the FIRST completion tag ("ALL PASS"/"ALL FAIL" — emitted after ALL
# scenarios ran). Two capture disciplines already burned here: (1) a second
# `am start` inside the poll ran onCreate twice (fixed: launch is retried on
# its own, never bundled with the completion condition); (2) even with one
# launch, the API-35 emulator intermittently delivers the activity twice
# ~80ms after the first suite completes — `logcat -d` AFTER the fact then
# returns TWO interleaved runs and the one-to-one checker rightly rejects
# the doubled log while the device itself reports ALL PASS twice. So: the
# checker input is the stream TRUNCATED at the first completion tag —
# exactly one run's stream, by construction. The capture is the shared
# canary-pinned discipline (logcat-capture.sh): `logcat -c` races the
# reader's initial snapshot, so a PREVIOUS run's buffered
# `dsh.runtime.result: ALL` can pierce the clear and satisfy this run's wait —
# both the wait and the truncation judge the canary view only.
adb shell am force-stop com.dshmobile.host >/dev/null 2>&1 || true
STREAM=/tmp/dsh-dsh-stream.txt
# the completion tag rides its own tag (dsh.runtime.result) — stream both
# (logcat tag specs are EXACT, -s dsh.runtime alone never sees it)
CANARY=$("$CAPTURE" start -f "$STREAM" dsh.dsh dsh.runtime.result)
cleanup() { "$CAPTURE" stop -f "$STREAM" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
deadline=$(( $(date +%s) + 120 ))
until adb shell am start -n com.dshmobile.host/.MainActivity >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "::error::am start kept failing within 120s"
        exit 1
    fi
    sleep 2
done
"$CAPTURE" wait -f "$STREAM" "$CANARY" 120 "dsh.runtime.result: ALL" || {
    echo "::error::dsh scenarios did not complete within 120s"
    tail -200 "$STREAM"
    exit 1
}
sleep 0.3          # let the completion-tag line itself flush
trap - EXIT
cleanup

"$CAPTURE" view -f "$STREAM" "$CANARY" | sed '/dsh.runtime.result: ALL/q' > /tmp/dsh-dsh-logs.txt
grep 'dsh.runtime.result' /tmp/dsh-dsh-logs.txt > /tmp/dsh-dsh-results.txt
cat /tmp/dsh-dsh-results.txt

# E2E by logs: one checker verdict per scenario manifest against the shared
# canonical stream (checkers filter on the records' scenario field).
node test/e2e/check.mjs \
    --manifest test/e2e/scenarios/boot-verification.json \
    --log /tmp/dsh-dsh-logs.txt \
    --out /tmp/dsh-dsh-verdict-m1.json
cat /tmp/dsh-dsh-verdict-m1.json
node test/e2e/check.mjs \
    --manifest test/e2e/scenarios/gateway-bridge-smoke.json \
    --log /tmp/dsh-dsh-logs.txt \
    --out /tmp/dsh-dsh-verdict-m2.json
cat /tmp/dsh-dsh-verdict-m2.json
node test/e2e/check.mjs \
    --manifest test/e2e/scenarios/session-mock-llm.json \
    --log /tmp/dsh-dsh-logs.txt \
    --out /tmp/dsh-dsh-verdict-session.json
cat /tmp/dsh-dsh-verdict-session.json
