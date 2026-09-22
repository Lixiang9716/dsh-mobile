#!/bin/sh
# run-spike-e2e.sh — one invocation drives the whole on-emulator E2E:
# boot wait -> install -> launch -> deadline poll -> capture -> checker verdict.
#
# Why a single script driving the emulator directly: android-emulator-runner
# proved hostile twice — it executes its `script:` one `sh -c` PER LINE (a
# multi-line `until` loop split mid-syntax and died), and its built-in
# disable-animations pass failed broken-pipe seconds after sys.boot_completed.
# Here every wait is a polled condition with a deadline (rules.md rule 8 —
# sleeps only pace polling) and every exhaustion is loud (rule 5).
set -eu

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

adb logcat -c

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
# exactly one run's stream, by construction.
adb shell am force-stop com.dshmobile.spike >/dev/null 2>&1 || true
STREAM=/tmp/dsh-spike-stream.txt
: > "$STREAM"
# the completion tag rides its own tag (dsh.spike.result) — stream both
# (logcat tag specs are EXACT, -s dsh.spike alone never sees it)
adb logcat -s dsh.spike dsh.spike.result > "$STREAM" 2>/dev/null &
streamer=$!
deadline=$(( $(date +%s) + 120 ))
until adb shell am start -n com.dshmobile.spike/.MainActivity >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "::error::am start kept failing within 120s"
        kill "$streamer" 2>/dev/null || true
        exit 1
    fi
    sleep 2
done
deadline=$(( $(date +%s) + 120 ))
until grep -q "dsh.spike.result: ALL" "$STREAM"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "::error::spike scenarios did not complete within 120s"
        kill "$streamer" 2>/dev/null || true
        tail -200 "$STREAM"
        exit 1
    fi
    sleep 0.2
done
sleep 0.3          # let the completion-tag line itself flush
kill "$streamer" 2>/dev/null || true
wait "$streamer" 2>/dev/null || true

sed '/dsh.spike.result: ALL/q' "$STREAM" > /tmp/dsh-spike-logs.txt
grep 'dsh.spike.result' /tmp/dsh-spike-logs.txt > /tmp/dsh-spike-results.txt
cat /tmp/dsh-spike-results.txt

# E2E by logs: one checker verdict per scenario manifest against the shared
# canonical stream (checkers filter on the records' scenario field).
node test/e2e/check.mjs \
    --manifest test/e2e/scenarios/m1-spike-boot.json \
    --log /tmp/dsh-spike-logs.txt \
    --out /tmp/dsh-spike-verdict-m1.json
cat /tmp/dsh-spike-verdict-m1.json
node test/e2e/check.mjs \
    --manifest test/e2e/scenarios/m2-bridge-smoke.json \
    --log /tmp/dsh-spike-logs.txt \
    --out /tmp/dsh-spike-verdict-m2.json
cat /tmp/dsh-spike-verdict-m2.json
node test/e2e/check.mjs \
    --manifest test/e2e/scenarios/m2-session.json \
    --log /tmp/dsh-spike-logs.txt \
    --out /tmp/dsh-spike-verdict-session.json
cat /tmp/dsh-spike-verdict-session.json
