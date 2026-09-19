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

adb wait-for-device

# Boot completion; CI boots measured ~7.5 min, so the deadline is generous.
deadline=$(( $(date +%s) + 600 ))
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
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

# Launch and wait for the completion tag. am start itself can transiently
# fail while services settle, so the whole condition is retried — once the
# activity exists, a relaunch only brings it to front (onCreate, and thus
# the scenario, runs once).
deadline=$(( $(date +%s) + 120 ))
until adb shell am start -n com.dshmobile.spike/.MainActivity >/dev/null 2>&1 &&
      adb logcat -d -s dsh.spike.result 2>/dev/null | grep -q dsh.spike.result; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "::error::scenario m1.spike.boot did not complete within 120s"
        adb logcat -d | tail -200
        exit 1
    fi
    sleep 2
done

adb logcat -d -s dsh.spike > /tmp/dsh-spike-logs.txt
node tools/e2e/check.mjs \
    --manifest tools/e2e/scenarios/m1-spike-boot.json \
    --log /tmp/dsh-spike-logs.txt \
    --out /tmp/dsh-spike-verdict.json
cat /tmp/dsh-spike-verdict.json
