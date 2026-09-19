#!/bin/sh
# await-spike-result.sh — poll logcat for the dsh.spike.result completion tag
# with a deadline (AGENTS.md rule 8: wait on conditions, not clocks — poll the
# condition, fail loud when the deadline passes; the sleep only paces polling).
#
# Why a script file: the android-emulator-runner executes its `script:` one
# `/usr/bin/sh -c` invocation PER LINE, so multi-line shell constructs
# (`until ... do ... done` spanning lines) are split mid-syntax and die with
# "end of file unexpected". Keeping the loop here gives it one invocation.
set -u

deadline=$(( $(date +%s) + 120 ))
while ! adb logcat -d -s dsh.spike.result 2>/dev/null | grep -q dsh.spike.result; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "::error::scenario m1.spike.boot did not complete within 120s"
        adb logcat -d | tail -200
        exit 1
    fi
    sleep 2
done
