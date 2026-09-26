#!/bin/sh
# run-whale-mount.sh — the whale creation-client mount on the HarmonyOS
# emulator (harmony.whale.mount, the iOS session-mock-llm drive's --client
# whale leg and the Android dsh.whale leg's sibling): ONE launch with
# --ps dsh.e2e.leg whale.mount, the session-mock scenario over the staged
# whale page, evidence = the phase capture file (E2E by logs) + one
# screenshot (human evidence only). Every wait is a polled condition with a
# deadline (rules.md rule 8); every exhaustion fails loud (rule 5).
set -eu

CLT=${HOS_CLT_HOME:-/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools}
HDC=${HDC_PATH:-$CLT/sdk/default/openharmony/toolchains/hdc}
HAP=hosts/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap
BUNDLE=com.dshmobile.spike
BASE=/data/app/el2/100/base/$BUNDLE/haps/entry/cache
CAPTURE=$BASE/dsh-whale-mount-capture.log
OUT=${1:-hosts/harmony/artifacts/whale-mount}

say() { echo "run-whale-mount: $*"; }
die() { echo "::error::run-whale-mount: $*" >&2; exit 1; }

# The emulator must be reachable (the dsh_phone instance; run-host-e2e.sh's
# wait, bounded).
deadline=$(( $(date +%s) + 120 ))
until "$HDC" list targets | grep -q 127.0.0.1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "no HarmonyOS emulator (127.0.0.1) within 120s"
    sleep 3
done

# Build here (or DSH_SKIP_BUILD=1 to reuse a built HAP), then install.
if [ "${DSH_SKIP_BUILD:-0}" != "1" ]; then
    say "building the HAP (hvigorw assembleHap, debug)"
    ( cd hosts/harmony && "$CLT/bin/hvigorw" assembleHap --mode module \
        -p product=default -p buildMode=debug --no-daemon ) \
        || die "hvigorw assembleHap failed"
fi
[ -f "$HAP" ] || die "build produced no HAP at $HAP"

deadline=$(( $(date +%s) + 180 ))
until "$HDC" install -r "$HAP" >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "hdc install kept failing within 180s"
    sleep 5
done

# Launch VERIFIED (run-host-e2e.sh's rule: the waited-for condition is the
# PID; right after install the BMS still settles and aa start lies).
deadline=$(( $(date +%s) + 120 ))
until [ -n "$("$HDC" shell pidof $BUNDLE 2>/dev/null | tr -d '[:space:]')" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        die "$BUNDLE process never appeared within 120s of aa start"
    fi
    "$HDC" shell power-shell wakeup >/dev/null 2>&1 || true
    "$HDC" shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
    "$HDC" shell aa start -b $BUNDLE -a EntryAbility \
        --ps dsh.e2e.leg whale.mount >/dev/null 2>&1 || true
    sleep 3
done

mkdir -p "$OUT"
# The scenario's own evidence in the capture (polled, bounded): the LAST
# manifest record is ws.session-complete. (The C host's verdict line rides
# hilog, not the capture — drive-binding's channel; the checker over the
# capture is this runner's verdict.)
deadline=$(( $(date +%s) + 420 ))
until "$HDC" shell "cat $CAPTURE 2>/dev/null" | grep -q "ws.session-complete"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        "$HDC" shell "cat $CAPTURE 2>/dev/null" | tail -40 >&2 || true
        die "harmony.whale.mount did not complete within 420s"
    fi
    sleep 2
done
sleep 3 # let the trailing records (the page's late re-ack) settle

"$HDC" shell snapshot_display -f /data/local/tmp/dsh-whale.jpeg >/dev/null 2>&1 || true
"$HDC" file recv /data/local/tmp/dsh-whale.jpeg "$OUT/01-whale-mounted.jpeg" >/dev/null 2>&1 || true
if [ -f "$OUT/01-whale-mounted.jpeg" ]; then
    sips -s format png "$OUT/01-whale-mounted.jpeg" \
        --out "$OUT/01-whale-mounted.png" >/dev/null
    rm -f "$OUT/01-whale-mounted.jpeg"
fi

# The C host's capture writes are buffered — the wait condition greps the
# DEVICE copy, and an immediate recv can race the last flush (measured: a
# pulled file missing the tail the device already showed). Verify the pull
# carries the terminal marker; one bounded re-pull otherwise.
pull_verified=0
for attempt in 1 2 3; do
    "$HDC" file recv "$CAPTURE" "$OUT/logs.txt" >/dev/null 2>&1 \
        || die "capture file $CAPTURE never landed"
    if grep -q "ws.session-complete" "$OUT/logs.txt" && grep -q "dsh.spike.verdict" "$OUT/logs.txt"; then
        pull_verified=1
        break
    fi
    sleep 3
done
[ "$pull_verified" = "1" ] || die "capture pull kept missing the terminal records"
grep '^dsh.spike.log:' "$OUT/logs.txt" > "$OUT/scenario.jsonl" || true

node test/e2e/check.mjs --manifest test/e2e/scenarios/harmony-whale-mount.json \
    --log "$OUT/logs.txt" --out "$OUT/verdict-harmony-whale-mount.json"
cat "$OUT/verdict-harmony-whale-mount.json"
say "harmony.whale.mount green — evidence under $OUT"
