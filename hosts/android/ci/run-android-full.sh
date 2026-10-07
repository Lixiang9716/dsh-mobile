#!/bin/sh
# run-android-full.sh — the FULL Android E2E: the three-scenario regression
# (run-dsh-e2e.sh, untouched) plus the M4 completion session
# (`android.capability-binding`: loopback carrier + WebView mount + the real
# nine-primitive gateway binding, UI-driven where native). Evidence: the
# canonical log stream bounded at the first `dsh.runtime.result: ALL` line,
# judged from the canary onward (the shared canary-pinned capture discipline,
# hosts/android/ci/logcat-capture.sh), one checker verdict per manifest, and
# screenshots at each UI stage (human evidence only — never a checker input).
#
# Every wait is a polled condition with a deadline (rules.md rule 8); every
# exhaustion is loud (rule 5). UI automation follows the same discipline:
# uiautomator dump -> find node -> tap, re-polled until a deadline passes.
#
# DSH_PHASES — optional comma list of the phases to run (default "1,2,3,4,5";
# e.g. DSH_PHASES=2,3,4,5 runs everything but the phase-1 regression that
# run-dsh-e2e.sh already covers elsewhere). Unknown values abort with the
# offending name (rule 5); skipped phases announce themselves so a partial
# run can never masquerade as the full sweep.
set -eu

CAPTURE="$(cd "$(dirname "$0")" && pwd)/logcat-capture.sh"
APK=hosts/android/app/build/outputs/apk/debug/app-debug.apk
PKG=com.dshmobile.host
OUT=${DSH_M4_OUT:-/tmp}
SCEN=test/e2e/scenarios
M4_STREAM=$OUT/dsh-m4-stream.txt
DSH_PHASES=${DSH_PHASES:-1,2,3,4,5}

say() { echo "run-android-full: $*"; }
die() { echo "::error::run-android-full: $*" >&2; exit 1; }

# Validate BEFORE any side effect: only 1-5, comma-separated, no spaces.
case "$DSH_PHASES" in
    [1-5]|[1-5],[1-5]|[1-5],[1-5],[1-5]|[1-5],[1-5],[1-5],[1-5]|[1-5],[1-5],[1-5],[1-5],[1-5]) ;;
    *) die "DSH_PHASES='$DSH_PHASES' is not a comma list of phases 1-5" ;;
esac
phase_wanted() { case ",$DSH_PHASES," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
say "phases: $DSH_PHASES"
for p in 1 2 3 4 5; do
    phase_wanted $p || say "phase $p: SKIPPED (DSH_PHASES=$DSH_PHASES)"
done

# ---- Build here, not "bring your own APK": a stale pre-built APK silently
# re-proves a build that is no longer the tree (measured 2026-09-22: a
# pre-change APK passed every manifest while the tree had moved on, and an
# mtime guard cannot see staged-asset staleness because re-staging identical
# bytes bumps their mtimes past the APK). gradlew is the guard: it re-runs
# the asset stager and packaging in dependency order and no-ops when the
# tree is truly unchanged.
say "building the APK (assembleDebug; no-ops when up to date)"
( cd hosts/android && ./gradlew :app:assembleDebug -q ) \
    || die "gradle :app:assembleDebug failed — set ANDROID_HOME if the SDK is missing"
[ -f "$APK" ] || die "build produced no APK at $APK"

# ---- device + boot, one bounded poll (same discipline as run-dsh-e2e.sh)
deadline=$(( $(date +%s) + 600 ))
until adb get-state >/dev/null 2>&1 &&
      [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    [ "$(date +%s)" -ge "$deadline" ] && die "emulator not booted within 600s"
    sleep 5
done

# The receipt host line (write-receipt.sh's DSH_RECEIPT_HOST): the emulator
# serial, its AVD name and API level — the machine-a-run-happened-on record
# the e2e-matrix acceptance bar demands (a receipt certifies a run, and the
# run's device belongs in it).
SERIAL=$(adb devices | awk 'NR==2 && $2=="device" {print $1}')
[ -n "$SERIAL" ] || die "no adb device found after boot poll"
AVD=$(adb -s "$SERIAL" emu avd name 2>/dev/null | head -1 | tr -d '\r')
API=$(adb -s "$SERIAL" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
HOST_LINE="Android emulator ($SERIAL, ${AVD:-unknown-avd} / API ${API:-?})"

# Pin the device timezone to an IANA Area/Location name. The composer
# surface's session/prompt envelope carries the WebView's clientTimeZone and
# the upstream util-time wire contract admits only UTC or an IANA
# Area/Location — the AOSP emulator's default "GMT" zone makes the WebView
# report bare "GMT" and the turn would be refused (session/invalid-time-zone).
# adb root is a no-op on images that refuse it; the app relaunches per phase
# and a fresh process picks the zone up.
adb root >/dev/null 2>&1 || true
adb wait-for-device >/dev/null 2>&1
adb shell setprop persist.sys.timezone Asia/Shanghai >/dev/null 2>&1 || true

# ---- E2E staging: notification permission + the SAF picker target
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null \
    || say "POST_NOTIFICATIONS grant skipped (pre-33 or already granted)"
adb shell mkdir -p /sdcard/dsh-e2e
adb shell "printf 'gateway e2e target file - dsh-mobile m4\n' > /sdcard/dsh-e2e/notes.txt"
adb shell cat /sdcard/dsh-e2e/notes.txt | grep -q "dsh-mobile m4" \
    || die "picker target /sdcard/dsh-e2e/notes.txt not staged"

# ---- phase 1: the regression suite (m1 + gateway.bridge-smoke + session.mock-llm)
# Phase bodies sit at column 0 inside their guards on purpose: the
# guard is a mechanical wrapper (sh does not care about the indent),
# and reindenting ~400 lines would bury the real diff of this change.
if phase_wanted 1; then
say "phase 1: three-scenario regression"
bash hosts/android/ci/run-dsh-e2e.sh
fi

# The m4 phase's notify leg needs POST_NOTIFICATIONS: the grant above ran
# BEFORE the phase-1 install, so on a fresh device adb refused it (the
# package did not exist yet) and the scenario's notify primitive would
# answer "refused by user policy". Re-grant now that the app exists —
# idempotent, and the `|| say` keeps pre-33 images quiet.
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null \
    || say "POST_NOTIFICATIONS re-grant skipped (pre-33 or already granted)"

# ---- phase 2: the M4 completion session -------------------------------
if phase_wanted 2; then
say "phase 2: android.capability-binding (carrier + WebView + gateway binding)"

shot() { adb exec-out screencap -p > "$OUT/dsh-m4-$1.png" 2>/dev/null || true; }

# Taps the first ENABLED UI node whose text/content-desc equals one of the
# alternatives in $1 (full-value match: the alternation stays inside the
# quotes, so "ALLOW" cannot hit "Allow DSH Dsh Host to access ...").
# Best effort: nonzero when no node matches this round.
tap_text() {
    adb shell uiautomator dump /sdcard/dsh-ui.xml >/dev/null 2>&1 || return 1
    # POSIX sh on purpose: `local` is undefined in dash (the workflow's sh).
    xml=$(adb shell cat /sdcard/dsh-ui.xml 2>/dev/null) || return 1
    printf '%s' "$xml" | sed 's/></>\n</g' | grep 'enabled="true"' \
      | grep -E "(text|content-desc)=\"($1)\"" | head -1 \
      | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p' \
      | {
        read -r x1 y1 x2 y2 || exit 0
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
# Line-buffered streamer with the canary pin (logcat-capture.sh start): the
# driver greps markers from the capture in real time, so the pump appends
# line by line (a plain `adb logcat > file &` block-buffers — the file only
# grows in 4KB flushes and the tail arrives at kill). Every marker grep and
# the completion wait judge the CANARY view: `logcat -c` races the reader's
# initial snapshot, and a stale pre-clear marker must not fire a screenshot,
# a tap, or the wait.
CANARY=$("$CAPTURE" start -f "$M4_STREAM" dsh.dsh dsh.runtime.result dsh.runtime.ui dsh.runtime.audit)
cview() { "$CAPTURE" view -f "$M4_STREAM" "$CANARY"; }
cleanup() {
    "$CAPTURE" stop -f "$M4_STREAM" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

deadline=$(( $(date +%s) + 60 ))
until adb shell am start -n $PKG/.MainActivity --ez dsh.m4 true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "am start kept failing within 60s"
    sleep 2
done

saw_mount=0; saw_picker=0; saw_approval=0; saw_notify=0
deadline=$(( $(date +%s) + 300 ))
until cview | grep -q "dsh.runtime.result: ALL"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        tail -80 "$M4_STREAM"
        die "m4 session did not complete within 300s"
    fi
    if [ "$saw_mount" -eq 0 ] && cview | grep -q "ws.session-complete"; then
        # the mounted page has the full session rendered; the binding leg's
        # first dialog is still ~1s away, so the shot catches the client
        saw_mount=1
        sleep 0.5
        shot 01-mount
    fi
    if [ "$saw_picker" -eq 0 ] && cview | grep -q "ui-wait picker"; then
        saw_picker=1; drive_picker
    fi
    if [ "$saw_approval" -eq 0 ] && cview | grep -q "ui-wait approval"; then
        # Material renders AlertDialog buttons uppercase (textAllCaps).
        saw_approval=1; shot 03-approval; tap_when_present "Approve|APPROVE"
    fi
    if [ "$saw_notify" -eq 0 ] && cview | grep -q "notify.scheduled"; then
        saw_notify=1
        adb shell input keyevent KEYCODE_HOME
        # background edge first (the manifest pins the event order)
        dline=$(( $(date +%s) + 20 ))
        until cview | grep -q '"state":"background"'; do
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

cview | sed '/dsh.runtime.result: ALL/q' > "$OUT/dsh-m4-logs.txt"
grep 'dsh.runtime.result' "$OUT/dsh-m4-logs.txt" > "$OUT/dsh-m4-results.txt"
cat "$OUT/dsh-m4-results.txt"
grep 'dsh.runtime.log:' "$OUT/dsh-m4-logs.txt" > "$OUT/dsh-m4-scenario.jsonl"
grep 'dsh.gateway.audit:' "$OUT/dsh-m4-logs.txt" > "$OUT/dsh-m4-audit.jsonl" || true

# E2E by logs: the binding scenario + the mandatory audit sequence (the
# audit records reuse the frozen gateway.audit manifest — the scenario's
# call order matches it), against the shared canonical stream.
node test/e2e/check.mjs --manifest $SCEN/android-capability-binding.json \
    --log "$OUT/dsh-m4-logs.txt" --out "$OUT/dsh-m4-verdict-binding.json"
cat "$OUT/dsh-m4-verdict-binding.json"
node test/e2e/check.mjs --manifest $SCEN/gateway-audit.json \
    --log "$OUT/dsh-m4-logs.txt" --out "$OUT/dsh-m4-verdict-audit.json"
cat "$OUT/dsh-m4-verdict-audit.json"
shot 05-final
say "phase 2 complete — evidence under $OUT/dsh-m4-*"
fi

# ---- phase 3: the official upstream web mount (android.officialweb.mount)
# The carrier serves the vendored official dist with the runtime-composed
# boot wire (web.boot over the bus seam) into the WebView; the same-origin
# probe drives POST /api + the remote.mux upgrade from inside the page.
# Same capture discipline as phase 2: a line-buffered logcat stream bounded
# at the first `dsh.runtime.result: ALL` line; screenshots are human evidence.
if phase_wanted 3; then
say "phase 3: android.officialweb.mount (official dist + web.boot drive + probe)"

ART=${DSH_WEB_ART:-hosts/android/artifacts/android-upstream}
WEB_STREAM=$OUT/dsh-web-stream.txt
mkdir -p "$ART/screens"

wshot() { adb exec-out screencap -p > "$ART/screens/$1.png" 2>/dev/null || true; }

adb shell am force-stop $PKG >/dev/null 2>&1 || true
# Same capture discipline as phase 2, via the shared canary-pinned script.
WCANARY=$("$CAPTURE" start -f "$WEB_STREAM" dsh.dsh dsh.runtime.result)
wview() { "$CAPTURE" view -f "$WEB_STREAM" "$WCANARY"; }
cleanup_web() {
    "$CAPTURE" stop -f "$WEB_STREAM" >/dev/null 2>&1 || true
}
trap cleanup_web EXIT INT TERM

deadline=$(( $(date +%s) + 60 ))
until adb shell am start -n $PKG/.MainActivity --ez dsh.web true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "am start kept failing within 60s"
    sleep 2
done

saw_index=0; saw_plugins=0
deadline=$(( $(date +%s) + 300 ))
until wview | grep -q "dsh.runtime.result: ALL"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        tail -80 "$WEB_STREAM"
        die "official-web drive did not complete within 300s"
    fi
    if [ "$saw_index" -eq 0 ] && wview | grep -q '"event":"index.served"'; then
        saw_index=1
        # index.served precedes first paint; give the boot page its ~1s to
        # paint so the shot shows the actual HARNESS boot screen, not a
        # blank document.
        sleep 1.2
        wshot 01-official-boot-screen
    fi
    if [ "$saw_plugins" -eq 0 ] && wview | grep -q '"event":"plugins.served"'; then
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

wview | sed '/dsh.runtime.result: ALL/q' > "$ART/logs.txt"
grep 'dsh.runtime.result' "$ART/logs.txt" > "$ART/results.txt"
cat "$ART/results.txt"
grep 'dsh.runtime.log:' "$ART/logs.txt" > "$ART/scenario.jsonl" || true

# ---- layout-truth probe (test/e2e/ui-probe.mjs, scenario ui.occlusion) ----
# The event stream cannot see the #179 class: a native surface painted over
# the WebView never logs anything, and the page's own drive probes only
# prove what the page CAN reach. The mounted shell is still foregrounded
# here (the post-verdict screen IS the mounted-shell evidence), so its tree
# dump is the honest geometry. The record rides the same captured log on
# its own dsh.ui.probe: prefix and gets its own one-to-one verdict —
# committed evidence for the existing manifests stays frozen (matrix.mjs
# drift-checks expect counts, so a new row in android-officialweb-mount.json
# would retro-count events the frozen captures cannot contain).
ui_dump() { # $1 out path — bounded retries (rule 8); uiautomator can refuse
    deadline=$(( $(date +%s) + 30 ))                        # a mid-layout tree
    while :; do
        adb shell uiautomator dump /sdcard/dsh-ui.xml >/dev/null 2>&1 &&
            adb shell cat /sdcard/dsh-ui.xml > "$1" 2>/dev/null && [ -s "$1" ] && return 0
        [ "$(date +%s)" -ge "$deadline" ] && return 1
        sleep 1
    done
}
ui_dump "$ART/ui-tree.xml" || die "official-web: uiautomator dump failed within 30s"
node test/e2e/ui-probe.mjs --dump "$ART/ui-tree.xml" \
    --scenario ui.occlusion --append "$ART/logs.txt" --json "$ART/ui-probe.json"
node test/e2e/check.mjs --manifest $SCEN/ui-occlusion.json \
    --log "$ART/logs.txt" --out "$ART/verdict-ui-occlusion.json"
cat "$ART/verdict-ui-occlusion.json"

adb pull "/data/data/$PKG/files/dsh-capture-android-officialweb-mount.log" \
    "$ART/capture-android-officialweb-mount.log" >/dev/null 2>&1 \
    || say "capture file pull skipped (run-as fallback)"
[ -f "$ART/capture-android-officialweb-mount.log" ] ||
    adb exec-out run-as $PKG cat files/dsh-capture-android-officialweb-mount.log \
    > "$ART/capture-android-officialweb-mount.log" 2>/dev/null || true

node test/e2e/check.mjs --manifest $SCEN/android-officialweb-mount.json \
    --log "$ART/logs.txt" --out "$ART/verdict-android-officialweb-mount.json"
cat "$ART/verdict-android-officialweb-mount.json"
# Receipt: machine-authored here, reachable ONLY because the checker above
# passed (set -eu) — the green-path emission the known-gaps register names.
DSH_RECEIPT_HOST="$HOST_LINE" sh test/e2e/write-receipt.sh "$ART" "$SERIAL" \
    "hosts/android/ci/run-android-full.sh" "officialweb-mount" \
    "am start -n $PKG/.MainActivity --ez dsh.web true" \
    android-officialweb-mount
say "phase 3 complete — evidence under $ART"
fi

# ---- phase 4: the session-live mount (android.session.live-read) -------------
# The FULL upstream agent spine boots on-device and claims /api/session.list
# + the mux session/journal streams over the bus seam; the official page
# boots with REAL session data: one scripted-llm turn before the page loads
# (the journal baseline) and one streamed LIVE into the attached page. The
# scripted /mock-llm/chat/completions carrier endpoint is the model boundary
# (E2E determinism, logged as such by the scenario's llm/runtime record).
# Same capture discipline as phase 3; screenshots are human evidence.
if phase_wanted 4; then
say "phase 4: android.session.live-read (spine boot + claims + journal probe)"

SART=${DSH_SESSION_ART:-hosts/android/artifacts/android-session-live}
SESSION_STREAM=$OUT/dsh-session-stream.txt
mkdir -p "$SART/screens"

sshots() { adb exec-out screencap -p > "$SART/screens/$1.png" 2>/dev/null || true; }

adb shell am force-stop $PKG >/dev/null 2>&1 || true
# Same capture discipline as phase 3, via the shared canary-pinned script.
SECANARY=$("$CAPTURE" start -f "$SESSION_STREAM" dsh.dsh dsh.runtime.result)
sview() { "$CAPTURE" view -f "$SESSION_STREAM" "$SECANARY"; }
cleanup_session() {
    "$CAPTURE" stop -f "$SESSION_STREAM" >/dev/null 2>&1 || true
}
trap cleanup_session EXIT INT TERM

deadline=$(( $(date +%s) + 60 ))
until adb shell am start -n $PKG/.MainActivity --ez dsh.session true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "am start kept failing within 60s"
    sleep 2
done

saw_index=0; saw_list=0; saw_journal=0
deadline=$(( $(date +%s) + 300 ))
until sview | grep -q "dsh.runtime.result: ALL"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        tail -80 "$SESSION_STREAM"
        die "session-live drive did not complete within 300s"
    fi
    if [ "$saw_index" -eq 0 ] && sview | grep -q '"event":"index.served"'; then
        saw_index=1
        # index.served precedes first paint; give the boot page its ~1s.
        sleep 1.2
        sshots 01-session-live-boot
    fi
    if [ "$saw_list" -eq 0 ] && sview | grep -q '"event":"session.list.responded"'; then
        saw_list=1
        sleep 0.5
        sshots 02-session-list-real
    fi
    if [ "$saw_journal" -eq 0 ] && sview | grep -q '"event":"journal/live"'; then
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

sview | sed '/dsh.runtime.result: ALL/q' > "$SART/logs.txt"
grep 'dsh.runtime.result' "$SART/logs.txt" > "$SART/results.txt"
cat "$SART/results.txt"
grep 'dsh.runtime.log:' "$SART/logs.txt" > "$SART/scenario.jsonl" || true
adb exec-out run-as $PKG cat files/dsh-capture-android-session-live-read.log \
    > "$SART/capture-android-session-live-read.log" 2>/dev/null || true

node test/e2e/check.mjs --manifest $SCEN/android-session-live-read.json \
    --log "$SART/logs.txt" --out "$SART/verdict-android-session-live-read.json"
cat "$SART/verdict-android-session-live-read.json"
DSH_RECEIPT_HOST="$HOST_LINE" sh test/e2e/write-receipt.sh "$SART" "$SERIAL" \
    "hosts/android/ci/run-android-full.sh" "session-live-read" \
    "am start -n $PKG/.MainActivity --ez dsh.session true" \
    android-session-live-read
say "phase 4 complete — evidence under $SART"
fi

# ---- phase 5: the session WRITE mount (android.composer.live-write) ---------------
# The spine + the official WRITE surface over the bus seam; the probe drives
# the REAL composer (pick the seeded workspace, type, click send) and the
# page's own message produces a REAL upstream agent-loop turn — the reply
# streams live over the mux journal and renders back into the official UI.
# The scripted /mock-llm/chat/completions carrier endpoint is the model
# boundary (E2E determinism, logged as such by the llm/runtime record).
# Same capture discipline as phases 3-4; screenshots are human evidence.
if phase_wanted 5; then
say "phase 5: android.composer.live-write (spine + write surface + composer probe)"

WART=${DSH_WRITE_ART:-hosts/android/artifacts/android-write-live}
WRITE_STREAM=$OUT/dsh-write-stream.txt
mkdir -p "$WART/screens"

wshots() { adb exec-out screencap -p > "$WART/screens/$1.png" 2>/dev/null || true; }

adb shell am force-stop $PKG >/dev/null 2>&1 || true
# Same capture discipline as phases 3-4, via the shared canary-pinned script.
WRCANARY=$("$CAPTURE" start -f "$WRITE_STREAM" dsh.dsh dsh.runtime.result)
wrview() { "$CAPTURE" view -f "$WRITE_STREAM" "$WRCANARY"; }
cleanup_write() {
    "$CAPTURE" stop -f "$WRITE_STREAM" >/dev/null 2>&1 || true
}
trap cleanup_write EXIT INT TERM

deadline=$(( $(date +%s) + 60 ))
until adb shell am start -n $PKG/.MainActivity --ez dsh.write true >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "am start kept failing within 60s"
    sleep 2
done

saw_index=0; saw_typed=0; saw_reply=0
deadline=$(( $(date +%s) + 300 ))
until wrview | grep -q "dsh.runtime.result: ALL"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        tail -80 "$WRITE_STREAM"
        die "write-live drive did not complete within 300s"
    fi
    if [ "$saw_index" -eq 0 ] && wrview | grep -q '"event":"index.served"'; then
        saw_index=1
        # index.served precedes first paint; give the boot page its ~1s.
        sleep 1.2
        wshots 01-write-boot-screen
    fi
    if [ "$saw_typed" -eq 0 ] && wrview | grep -q '"event":"composer.ready"'; then
        saw_typed=1
        sleep 0.5
        wshots 02-composer-typed
    fi
    if [ "$saw_reply" -eq 0 ] && wrview | grep -q '"event":"write.reply.rendered"'; then
        saw_reply=1
        sleep 0.5
        wshots 03-reply-rendered
    fi
    sleep 0.3
done
# The final shot lives AFTER the loop on purpose: the probe's verdict and
# the ALL marker flush in the same logcat burst. The page stays mounted
# after the verdict, so the post-loop screen IS the settled state.
sleep 0.5
wshots 03-reply-rendered
wshots 04-final-state
trap - EXIT
cleanup_write

wrview | sed '/dsh.runtime.result: ALL/q' > "$WART/logs.txt"
grep 'dsh.runtime.result' "$WART/logs.txt" > "$WART/results.txt"
cat "$WART/results.txt"
grep 'dsh.runtime.log:' "$WART/logs.txt" > "$WART/scenario.jsonl" || true
adb exec-out run-as $PKG cat files/dsh-capture-android-composer-live-write.log \
    > "$WART/capture-android-composer-live-write.log" 2>/dev/null || true

node test/e2e/check.mjs --manifest $SCEN/android-composer-live-write.json \
    --log "$WART/logs.txt" --out "$WART/verdict-android-composer-live-write.json"
cat "$WART/verdict-android-composer-live-write.json"
DSH_RECEIPT_HOST="$HOST_LINE" sh test/e2e/write-receipt.sh "$WART" "$SERIAL" \
    "hosts/android/ci/run-android-full.sh" "composer-live-write" \
    "am start -n $PKG/.MainActivity --ez dsh.write true" \
    android-composer-live-write
say "phase 5 complete — evidence under $WART"
fi
