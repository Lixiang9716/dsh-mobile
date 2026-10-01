#!/bin/sh
# hosts/android/ci/run-device-plane.sh — the v1.5.0 device-plane E2E leg
# (scenario `android.device-plane`): boots the emulator if needed, installs
# the debug APK, seeds ONE photo into the media store (the media-picker
# grid's deterministic first cell), launches with `--ez dsh.deviceplane
# true`, drives the native surfaces marker-by-marker (clipboard approval
# ladder, the two share sheets, the PhotoPicker), truncates the canary
# stream at the completion tag, and runs the scenario + audit checkers.
# Evidence lands under hosts/android/artifacts/device-plane/ (the
# e2e-matrix deliverables: logs.txt, scenario.jsonl, receipt.json, verdicts).
#
# usage: run-device-plane.sh [--skip-build]   (env: DSH_ANDROID_ART overrides
#        the evidence dir; DSH_ANDROID_SERIAL pins a booted emulator)
set -u
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT" || exit 1
PKG=com.dshmobile.spike
OUT="${DSH_ANDROID_ART:-hosts/android/artifacts/device-plane}"
SCEN=test/e2e/scenarios
APK=hosts/android/app/build/outputs/apk/debug/app-debug.apk
SERIAL="${DSH_ANDROID_SERIAL:-}"
SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

say() { echo "run-device-plane: $*"; }
die() { echo "run-device-plane: FAIL: $*" >&2; exit 1; }
shot() { adb $SERIAL shell screencap -p /sdcard/dsh-shot.png >/dev/null 2>&1 && adb $SERIAL pull /sdcard/dsh-shot.png "$OUT/screens/$1.png" >/dev/null 2>&1 || true; }
adbsh() { if [ -n "$SERIAL" ]; then adb -s "$SERIAL" "$@"; else adb "$@"; fi; }

mkdir -p "$OUT/screens"

# ---- 1. build ---------------------------------------------------------------
if [ "$SKIP_BUILD" = "0" ]; then
    say "1/6 assembleDebug"
    ( cd hosts/android && ./gradlew assembleDebug --console=plain -q >/dev/null ) \
        || die "gradle assembleDebug failed"
else
    say "1/6 build skipped"
fi
[ -f "$APK" ] || die "APK missing at $APK (build first)"

# ---- 2. boot + install ------------------------------------------------------
say "2/6 boot poll + install"
adbsh wait-for-device
boot_deadline=$(( $(date +%s) + 120 ))
until adbsh shell getprop sys.boot_completed 2>/dev/null | grep -q 1; do
    [ "$(date +%s)" -ge "$boot_deadline" ] && die "emulator did not finish booting within 120s"
    sleep 2
done
adbsh install -r "$APK" >/dev/null || die "adb install failed"

# ---- 3. fixtures: one photo in the media store -------------------------------
say "3/6 seeding the media-store photo"
SEED_JPG="$OUT/screens/.media-seed.jpg"
PNG_SRC=$(ls hosts/ios/artifacts/gateway/screens/*.png 2>/dev/null | head -1 || true)
if [ -n "$PNG_SRC" ] && command -v sips >/dev/null 2>&1; then
    sips -s format jpeg -Z 128 "$PNG_SRC" --out "$SEED_JPG" >/dev/null 2>&1 || true
fi
if [ -s "$SEED_JPG" ]; then
    adbsh push "$SEED_JPG" /sdcard/Pictures/dsh-media-seed.jpg >/dev/null || true
    adbsh shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
        -d file:///sdcard/Pictures/dsh-media-seed.jpg >/dev/null 2>&1 || true
    sleep 2
else
    say "WARNING: no JPEG seed could be staged — the media leg drives cancellation"
fi

# ---- 4. launch ---------------------------------------------------------------
say "4/6 launch (--ez dsh.deviceplane true)"
# Deterministic capture (the streamer+canary design lost three ways here:
# zombie streamers from earlier runs kept writing the same file, logcat's
# start-of-buffer replay satisfied waits with STALE records, and an in-place
# file rewrite orphaned the streamer's fd — all measured 2026-09-26/27).
# Instead: clear the device buffer, launch CLEAN, and poll `logcat -d`
# snapshots — a dump is inherently this-run-only.
DUMP="$OUT/.dp-dump.txt"
: > "$DUMP"
adbsh shell am force-stop $PKG >/dev/null 2>&1 || true
stop_deadline=$(( $(date +%s) + 30 ))
while [ -n "$(adbsh shell pidof $PKG 2>/dev/null | tr -d '[:space:]')" ]; do
    [ "$(date +%s)" -ge "$stop_deadline" ] && die "force-stop left $PKG resident"
    adbsh shell am force-stop $PKG >/dev/null 2>&1 || true
    sleep 1
done
adbsh logcat -c

launch_deadline=$(( $(date +%s) + 60 ))
until adbsh shell am start -n $PKG/.MainActivity --ez dsh.deviceplane true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$launch_deadline" ] && die "am start kept failing within 60s"
    sleep 2
done
# The launch must produce a LIVE process with fresh records: singleTask
# delivery to an already-running instance re-runs nothing (verified via the
# force-stop above, plus a records-arrive poll below).
rec_deadline=$(( $(date +%s) + 60 ))
until adbsh logcat -d -s dsh.spike 2>/dev/null | grep -q "dsh.spike.log"; do
    [ "$(date +%s)" -ge "$rec_deadline" ] && die "no dsh.spike records within 60s of am start"
    sleep 1
done

# ---- 5. drive ----------------------------------------------------------------
# UI helpers over uiautomator dump; markers read from the logcat snapshot.
dump_xml() { adbsh shell uiautomator dump /sdcard/dsh-dump.xml >/dev/null 2>&1 && adbsh shell cat /sdcard/dsh-dump.xml; }
tap_text() { # EXACT_LABEL (a node whose text attribute equals it; & arrives XML-escaped)
    want="$1"
    xml=$(dump_xml) || return 1
    echo "$xml" | perl -ne 'while (/<node[^>]*? text="([^"]*)"[^>]*? bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g) { ($t,$a,$b,$c,$d)=($1,$2,$3,$4,$5); $t =~ s/&amp;/&/g; print "$t|$a|$b|$c|$d\n"; }' \
        > /tmp/.dsh-dp-matches
    while IFS='|' read -r label x1 y1 x2 y2; do
        [ "$label" = "$want" ] || continue
        x=$(( (x1 + x2) / 2 )); y=$(( (y1 + y2) / 2 ))
        adbsh shell input tap "$x" "$y"
        say "tapped [$want] at ($x,$y)"
        return 0
    done < /tmp/.dsh-dp-matches
    return 1
}
snapshot() { adbsh logcat -d -s dsh.spike dsh.spike.result dsh.spike.ui dsh.spike.audit > "$DUMP" 2>/dev/null; }

saw_clipboard=0
saw_share=0
saw_picker=0
deadline=$(( $(date +%s) + 420 ))
until snapshot && grep -q "dsh.spike.result: ALL" "$DUMP"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        tail -80 "$DUMP"
        die "device-plane scenario did not complete within 420s"
    fi
    reads=$(grep -c "ui-wait clipboard-read" "$DUMP")
    if [ "$reads" -gt "$saw_clipboard" ]; then
        # Material renders AlertDialog buttons uppercase (textAllCaps) —
        # exact-label taps (the message text also contains "Approve", so a
        # contains-match once tapped the message instead of the button).
        saw_clipboard=$reads
        sleep 1
        [ -f "$OUT/screens/01-clipboard-approve.png" ] || shot 01-clipboard-approve
        if [ "$reads" = "1" ]; then
            tap_text "APPROVE" || true
        else
            tap_text "APPROVE & REMEMBER" || tap_text "APPROVE" || true
        fi
    fi
    shares=$(grep -c "ui-wait share" "$DUMP")
    if [ "$shares" -gt "$saw_share" ]; then
        saw_share=$shares
        sleep 1.5
        [ -f "$OUT/screens/02-share.png" ] || shot 02-share
        # The system share sheet: complete with Copy when offered, else
        # dismiss by BACK (walking away is a value).
        tap_text "Copy" || { adbsh shell input keyevent KEYCODE_BACK; say "share -> BACK"; }
    fi
    pickers=$(grep -c "ui-wait picker" "$DUMP")
    if [ "$pickers" -gt "$saw_picker" ]; then
        saw_picker=$pickers
        sleep 2
        [ -f "$OUT/screens/03-picker-media.png" ] || shot 03-picker-media
        # PhotoPicker: a cell tap finishes the single-select pick. Probe the
        # dump for a photo-ish node; the BACK fallback pins cancellation.
        tap_text "Photo|photo|dsh-media-seed" || { adbsh shell input keyevent KEYCODE_BACK; say "media picker -> BACK (cancellation)"; }
    fi
    sleep 1
done
sleep 1
trap - EXIT
cleanup

# ---- 6. checkers -------------------------------------------------------------
say "6/6 checkers"
cp "$DUMP" "$OUT/logs.txt"
grep 'dsh.spike.result' "$OUT/logs.txt" > "$OUT/results.txt" || true
grep 'dsh.spike.log:' "$OUT/logs.txt" > "$OUT/scenario.jsonl" || true
grep 'dsh.gateway.audit:' "$OUT/logs.txt" > "$OUT/gateway-audit.jsonl" || true
shot 04-final

say "6/6 checkers"
grep 'dsh.spike.result' "$OUT/logs.txt" > "$OUT/results.txt" || true
grep 'dsh.spike.log:' "$OUT/logs.txt" > "$OUT/scenario.jsonl" || true
grep 'dsh.gateway.audit:' "$OUT/logs.txt" > "$OUT/gateway-audit.jsonl" || true
shot 04-final

FAIL=0
node test/e2e/check.mjs --manifest $SCEN/android-device-plane.json \
    --log "$OUT/logs.txt" --out "$OUT/verdict-android-device-plane.json" || FAIL=1
cat "$OUT/verdict-android-device-plane.json"
node test/e2e/check.mjs --manifest $SCEN/android-device-plane-audit.json \
    --log "$OUT/logs.txt" --out "$OUT/verdict-android-device-plane-audit.json" || FAIL=1
cat "$OUT/verdict-android-device-plane-audit.json"
[ "$FAIL" = "0" ] || die "checkers red — evidence stays unreceipted (rule: receipts only from green runs)"

UDID="$(adbsh get-serialno | tr -d '\r')"
TREE_LINE="origin/main $(git rev-parse --short=12 HEAD)$(git diff-index --quiet HEAD -- || echo ' (dirty working tree at receipt time)')"
cat > "$OUT/receipt.json" <<EOF
{
  "host": "android",
  "udid": "$UDID",
  "runner": "hosts/android/ci/run-device-plane.sh",
  "phase": "android.device-plane",
  "launch": "emulator, --ez dsh.deviceplane true (Debug)",
  "tree": "$TREE_LINE",
  "engine": "$(sed -n 's/^PIN=//p' runtime/spike/vendor/ensure.sh)",
  "scenarios": [
    { "manifest": "android-device-plane", "verdict": "verdict-android-device-plane.json", "pass": true },
    { "manifest": "android-device-plane-audit", "verdict": "verdict-android-device-plane-audit.json", "pass": true }
  ],
  "screens": ["screens/01-clipboard-approve.png", "screens/02-share.png", "screens/03-picker-media.png", "screens/04-final.png"],
  "producedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
say "receipt written — android.device-plane green ($OUT)"
