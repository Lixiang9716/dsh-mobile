#!/bin/sh
# run-android-full.sh — the FULL Android E2E: the three-scenario regression
# (run-spike-e2e.sh, untouched) plus the M4 completion session
# (`m4.host-binding`: loopback carrier + WebView mount + the real
# nine-primitive gateway binding, UI-driven where native). Evidence: the
# canonical log stream bounded at the first `dsh.spike.result: ALL` line
# (see run-spike-e2e.sh for the streaming-capture discipline), one checker
# verdict per manifest, and screenshots at each UI stage (human evidence
# only — never a checker input).
#
# Every wait is a polled condition with a deadline (rules.md rule 8); every
# exhaustion is loud (rule 5). UI automation follows the same discipline:
# uiautomator dump -> find node -> tap, re-polled until a deadline passes.
set -eu

APK=hosts/android/app/build/outputs/apk/debug/app-debug.apk
PKG=com.dshmobile.spike
OUT=${DSH_M4_OUT:-/tmp}
SCEN=tools/e2e/scenarios
M4_STREAM=$OUT/dsh-m4-stream.txt

say() { echo "run-android-full: $*"; }
die() { echo "::error::run-android-full: $*" >&2; exit 1; }

# ---- device + boot, one bounded poll (same discipline as run-spike-e2e.sh)
deadline=$(( $(date +%s) + 600 ))
until adb get-state >/dev/null 2>&1 &&
      [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    [ "$(date +%s)" -ge "$deadline" ] && die "emulator not booted within 600s"
    sleep 5
done

# ---- E2E staging: notification permission + the SAF picker target
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null \
    || say "POST_NOTIFICATIONS grant skipped (pre-33 or already granted)"
adb shell mkdir -p /sdcard/dsh-e2e
adb shell "printf 'gateway e2e target file - dsh-mobile m4\n' > /sdcard/dsh-e2e/notes.txt"
adb shell cat /sdcard/dsh-e2e/notes.txt | grep -q "dsh-mobile m4" \
    || die "picker target /sdcard/dsh-e2e/notes.txt not staged"

# ---- phase 1: the regression suite (m1 + m2.bridge.smoke + m2.session)
say "phase 1: three-scenario regression"
bash hosts/android/ci/run-spike-e2e.sh

# ---- phase 2: the M4 completion session -------------------------------
say "phase 2: m4.host-binding (carrier + WebView + gateway binding)"

shot() { adb exec-out screencap -p > "$OUT/dsh-m4-$1.png" 2>/dev/null || true; }

# Taps the first ENABLED UI node whose text/content-desc equals one of the
# alternatives in $1 (full-value match: the alternation stays inside the
# quotes, so "ALLOW" cannot hit "Allow DSH Spike Host to access ...").
# Best effort: nonzero when no node matches this round.
tap_text() {
    adb shell uiautomator dump /sdcard/dsh-ui.xml >/dev/null 2>&1 || return 1
    local xml
    xml=$(adb shell cat /sdcard/dsh-ui.xml 2>/dev/null) || return 1
    printf '%s' "$xml" | sed 's/></>\n</g' | grep 'enabled="true"' \
      | grep -E "(text|content-desc)=\"($1)\"" | head -1 \
      | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p' \
      | {
        read x1 y1 x2 y2 || exit 0
        adb shell input tap $(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 ))
        echo tapped
      } | grep -q tapped
}

# Polls the UI until one of $@ matches an enabled node, then taps it.
tap_when_present() {
    deadline=$(( $(date +%s) + 45 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        for label in "$@"; do
            if tap_text "$label"; then
                say "tapped UI node: $label"
                return 0
            fi
        done
        sleep 1
    done
    adb shell cat /sdcard/dsh-ui.xml 2>/dev/null | head -c 2000 || true
    die "no UI node matched ($*) within 45s"
}

# The SAF directory picker: enter the staged directory, then confirm. (The
# storage root's confirm button is disabled — only enabled nodes are tapped;
# API 35 additionally refuses Download/Documents for tree picks, hence the
# dedicated /sdcard/dsh-e2e target staged above.)
drive_picker() {
    shot 02-picker
    deadline=$(( $(date +%s) + 30 ))
    until tap_text "dsh-e2e"; do
        # A stray shade (e.g. the emulator's periodic "Serial console
        # enabled" notification) covers the picker and starves the dump —
        # collapse it each round before re-dumping.
        adb shell cmd statusbar collapse >/dev/null 2>&1 || true
        [ "$(date +%s)" -ge "$deadline" ] && die "picker: dsh-e2e not reachable within 30s"
        sleep 1
    done
    deadline=$(( $(date +%s) + 30 ))
    until tap_text "USE THIS FOLDER|Use this folder"; do
        [ "$(date +%s)" -ge "$deadline" ] && die "picker: confirm not enabled within 30s"
        sleep 1
    done
    # API 35 documents UI asks one more confirmation before granting.
    deadline=$(( $(date +%s) + 30 ))
    until tap_text "ALLOW|Allow|ALLOW ACCESS|Allow access"; do
        [ "$(date +%s)" -ge "$deadline" ] && die "picker: allow not reachable within 30s"
        sleep 1
    done
    say "picker driven"
}

adb shell am force-stop $PKG >/dev/null 2>&1 || true
adb logcat -c
: > "$M4_STREAM"
# Line-buffered stream: the driver greps markers from the file in real time,
# so a plain `adb logcat > file &` (stdio block buffering — the file only
# grows in 4KB flushes, and the tail arrives at kill) would starve it.
adb logcat -s dsh.spike dsh.spike.result dsh.spike.ui dsh.spike.audit 2>/dev/null \
    | while IFS= read -r line; do printf '%s\n' "$line" >> "$M4_STREAM"; done &
streamer=$!
cleanup() {
    kill "$streamer" 2>/dev/null || true
    pkill -f "logcat -s dsh.spike" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

deadline=$(( $(date +%s) + 60 ))
until adb shell am start -n $PKG/.MainActivity --ez dsh.m4 true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "am start kept failing within 60s"
    sleep 2
done

saw_mount=0; saw_picker=0; saw_approval=0; saw_notify=0
deadline=$(( $(date +%s) + 300 ))
until grep -q "dsh.spike.result: ALL" "$M4_STREAM"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        tail -80 "$M4_STREAM"
        die "m4 session did not complete within 300s"
    fi
    if [ "$saw_mount" -eq 0 ] && grep -q "ws.session-complete" "$M4_STREAM"; then
        # the mounted page has the full session rendered; the binding leg's
        # first dialog is still ~1s away, so the shot catches the client
        saw_mount=1
        sleep 0.5
        shot 01-mount
    fi
    if [ "$saw_picker" -eq 0 ] && grep -q "ui-wait picker" "$M4_STREAM"; then
        saw_picker=1; drive_picker
    fi
    if [ "$saw_approval" -eq 0 ] && grep -q "ui-wait approval" "$M4_STREAM"; then
        # Material renders AlertDialog buttons uppercase (textAllCaps).
        saw_approval=1; shot 03-approval; tap_when_present "Approve|APPROVE"
    fi
    if [ "$saw_notify" -eq 0 ] && grep -q "notify.scheduled" "$M4_STREAM"; then
        saw_notify=1
        adb shell input keyevent KEYCODE_HOME
        # background edge first (the manifest pins the event order)
        dline=$(( $(date +%s) + 20 ))
        until grep -q '"state":"background"' "$M4_STREAM"; do
            [ "$(date +%s)" -ge "$dline" ] && die "no app.state background within 20s"
            sleep 0.5
        done
        adb shell cmd statusbar expand-notifications || true
        sleep 2
        shot 04-notification
        tap_when_present "DSH E2E"
    fi
    sleep 0.3
done
sleep 0.3
trap - EXIT
cleanup

sed '/dsh.spike.result: ALL/q' "$M4_STREAM" > "$OUT/dsh-m4-logs.txt"
grep 'dsh.spike.result' "$OUT/dsh-m4-logs.txt" > "$OUT/dsh-m4-results.txt"
cat "$OUT/dsh-m4-results.txt"
grep 'dsh.spike.log:' "$OUT/dsh-m4-logs.txt" > "$OUT/dsh-m4-scenario.jsonl"
grep 'dsh.gateway.audit:' "$OUT/dsh-m4-logs.txt" > "$OUT/dsh-m4-audit.jsonl" || true

# E2E by logs: the binding scenario + the mandatory audit sequence (the
# audit records reuse the frozen m2.gateway.audit manifest — the scenario's
# call order matches it), against the shared canonical stream.
node tools/e2e/check.mjs --manifest $SCEN/m4-host-binding.json \
    --log "$OUT/dsh-m4-logs.txt" --out "$OUT/dsh-m4-verdict-binding.json"
cat "$OUT/dsh-m4-verdict-binding.json"
node tools/e2e/check.mjs --manifest $SCEN/m2-gateway-audit.json \
    --log "$OUT/dsh-m4-logs.txt" --out "$OUT/dsh-m4-verdict-audit.json"
cat "$OUT/dsh-m4-verdict-audit.json"
shot 05-final
say "phase 2 complete — evidence under $OUT/dsh-m4-*"

# ---- phase 3: the official upstream web mount (b-android.official-web-mount)
# The carrier serves the vendored official dist with the runtime-composed
# boot wire (web.boot over the bus seam) into the WebView; the same-origin
# probe drives POST /api + the remote.mux upgrade from inside the page.
# Same capture discipline as phase 2: a line-buffered logcat stream bounded
# at the first `dsh.spike.result: ALL` line; screenshots are human evidence.
say "phase 3: b-android.official-web.mount (official dist + web.boot drive + probe)"

ART=${DSH_WEB_ART:-hosts/android/artifacts/android-upstream}
WEB_STREAM=$OUT/dsh-web-stream.txt
mkdir -p "$ART/screens"

wshot() { adb exec-out screencap -p > "$ART/screens/$1.png" 2>/dev/null || true; }

adb shell am force-stop $PKG >/dev/null 2>&1 || true
adb logcat -c
: > "$WEB_STREAM"
adb logcat -s dsh.spike dsh.spike.result 2>/dev/null \
    | while IFS= read -r line; do printf '%s\n' "$line" >> "$WEB_STREAM"; done &
wstreamer=$!
cleanup_web() {
    kill "$wstreamer" 2>/dev/null || true
    pkill -f "logcat -s dsh.spike" 2>/dev/null || true
}
trap cleanup_web EXIT INT TERM

deadline=$(( $(date +%s) + 60 ))
until adb shell am start -n $PKG/.MainActivity --ez dsh.web true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "am start kept failing within 60s"
    sleep 2
done

saw_index=0; saw_plugins=0
deadline=$(( $(date +%s) + 300 ))
until grep -q "dsh.spike.result: ALL" "$WEB_STREAM"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        tail -80 "$WEB_STREAM"
        die "official-web drive did not complete within 300s"
    fi
    if [ "$saw_index" -eq 0 ] && grep -q '"event":"index.served"' "$WEB_STREAM"; then
        saw_index=1
        # index.served precedes first paint; give the boot page its ~1s to
        # paint so the shot shows the actual HARNESS boot screen, not a
        # blank document.
        sleep 1.2
        wshot 01-official-boot-screen
    fi
    if [ "$saw_plugins" -eq 0 ] && grep -q '"event":"plugins.served"' "$WEB_STREAM"; then
        saw_plugins=1
        sleep 0.5
        wshot 02-plugins-loading
    fi
    sleep 0.3
done
# The shell shot lives AFTER the loop on purpose: app.shell.rendered and the
# ALL marker flush in the same logcat burst, so an in-loop check races the
# loop condition and can miss. The shell stays mounted after the verdict, so
# the post-loop screen IS the mounted-shell evidence either way.
sleep 0.5
wshot 03-app-shell
wshot 04-final-state
trap - EXIT
cleanup_web

sed '/dsh.spike.result: ALL/q' "$WEB_STREAM" > "$ART/logs.txt"
grep 'dsh.spike.result' "$ART/logs.txt" > "$ART/results.txt"
cat "$ART/results.txt"
grep 'dsh.spike.log:' "$ART/logs.txt" > "$ART/scenario.jsonl" || true
adb pull "/data/data/$PKG/files/spike-capture-b-android-official-web-mount.log" \
    "$ART/capture-b-android-official-web-mount.log" >/dev/null 2>&1 \
    || say "capture file pull skipped (run-as fallback)"
[ -f "$ART/capture-b-android-official-web-mount.log" ] ||
    adb exec-out run-as $PKG cat files/spike-capture-b-android-official-web-mount.log \
    > "$ART/capture-b-android-official-web-mount.log" 2>/dev/null || true

node tools/e2e/check.mjs --manifest $SCEN/b-android-official-web-mount.json \
    --log "$ART/logs.txt" --out "$ART/verdict-b-android-official-web-mount.json"
cat "$ART/verdict-b-android-official-web-mount.json"
say "phase 3 complete — evidence under $ART"

# ---- phase 4: the session-live mount (b-android.session.live) -------------
# The FULL upstream agent spine boots on-device and claims /api/session.list
# + the mux session/journal streams over the bus seam; the official page
# boots with REAL session data: one scripted-llm turn before the page loads
# (the journal baseline) and one streamed LIVE into the attached page. The
# scripted /mock-llm/chat/completions carrier endpoint is the model boundary
# (E2E determinism, logged as such by the scenario's llm/runtime record).
# Same capture discipline as phase 3; screenshots are human evidence.
say "phase 4: b-android.session.live (spine boot + claims + journal probe)"

SART=${DSH_SESSION_ART:-hosts/android/artifacts/android-session-live}
SESSION_STREAM=$OUT/dsh-session-stream.txt
mkdir -p "$SART/screens"

sshots() { adb exec-out screencap -p > "$SART/screens/$1.png" 2>/dev/null || true; }

adb shell am force-stop $PKG >/dev/null 2>&1 || true
adb logcat -c
: > "$SESSION_STREAM"
adb logcat -s dsh.spike dsh.spike.result 2>/dev/null \
    | while IFS= read -r line; do printf '%s\n' "$line" >> "$SESSION_STREAM"; done &
sstreamer=$!
cleanup_session() {
    kill "$sstreamer" 2>/dev/null || true
    pkill -f "logcat -s dsh.spike" 2>/dev/null || true
}
trap cleanup_session EXIT INT TERM

deadline=$(( $(date +%s) + 60 ))
until adb shell am start -n $PKG/.MainActivity --ez dsh.session true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "am start kept failing within 60s"
    sleep 2
done

saw_index=0; saw_list=0; saw_journal=0
deadline=$(( $(date +%s) + 300 ))
until grep -q "dsh.spike.result: ALL" "$SESSION_STREAM"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        tail -80 "$SESSION_STREAM"
        die "session-live drive did not complete within 300s"
    fi
    if [ "$saw_index" -eq 0 ] && grep -q '"event":"index.served"' "$SESSION_STREAM"; then
        saw_index=1
        # index.served precedes first paint; give the boot page its ~1s.
        sleep 1.2
        sshots 01-session-live-boot
    fi
    if [ "$saw_list" -eq 0 ] && grep -q '"event":"session.list.responded"' "$SESSION_STREAM"; then
        saw_list=1
        sleep 0.5
        sshots 02-session-list-real
    fi
    if [ "$saw_journal" -eq 0 ] && grep -q '"event":"journal/live"' "$SESSION_STREAM"; then
        saw_journal=1
        sleep 0.5
        sshots 03-journal-live
    fi
    sleep 0.3
done
# The shell shot lives AFTER the loop on purpose: the probe's verdict and
# the ALL marker flush in the same logcat burst. The shell stays mounted
# after the verdict, so the post-loop screen IS the mounted-shell evidence.
sleep 0.5
sshots 03-journal-live
sshots 04-final-state
trap - EXIT
cleanup_session

sed '/dsh.spike.result: ALL/q' "$SESSION_STREAM" > "$SART/logs.txt"
grep 'dsh.spike.result' "$SART/logs.txt" > "$SART/results.txt"
cat "$SART/results.txt"
grep 'dsh.spike.log:' "$SART/logs.txt" > "$SART/scenario.jsonl" || true
adb exec-out run-as $PKG cat files/spike-capture-b-android-session-live.log \
    > "$SART/capture-b-android-session-live.log" 2>/dev/null || true

node tools/e2e/check.mjs --manifest $SCEN/b-android-session-live.json \
    --log "$SART/logs.txt" --out "$SART/verdict-b-android-session-live.json"
cat "$SART/verdict-b-android-session-live.json"
say "phase 4 complete — evidence under $SART"
