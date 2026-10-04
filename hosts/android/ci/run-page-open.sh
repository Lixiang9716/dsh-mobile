#!/bin/sh
# run-page-open.sh — the OFFICIAL seat's page-open pin (loop-t): a fresh boot
# of the default seat (SessionServe, scenario/composer-web-live.js) must end
# with the app's own WebView navigating to the carrier origin. The gate the
# page open rides — SessionServe.kt maybeOpenOrigin — needs the bus line
# `settings.probes.done` (the JS probes' completion post) plus the web.boot
# rows; a3e35d72 dropped that post and the page silently never opened again
# (url stayed '' forever, zero FAIL lines, because the passing probes never
# trigger the fail-open). Nothing else in CI drives the default seat, so this
# check is the only guard.
#
# The seat is RELEASE-flavor only (MainActivity: isRelease -> bootRelease();
# the harness/debug build's default boot runs the three regression scenarios
# instead), so the default APK is the signed release build — sign it with the
# debug keystore exactly like the install evidence does:
#   apksigner sign --ks ~/.android/debug.keystore \
#       --out app-release-signed.apk app-release-unsigned.apk
#
# Assertion surface (E2E by logs, never screenshots): the carrier's serving
# line in logcat (port), the webview devtools /json/list target list (the
# page url — must appear within the deadline, on THAT port, with the token),
# and zero scenario FAIL lines from this boot's pid. All three survive the
# release build's -DDSH_RELEASE log suppression: they are Kotlin Log.i lines
# and devtools state, never logger debug/info records.
#
# Every wait is a polled condition with a deadline (rules.md rule 8); every
# exhaustion is loud (rule 5).
set -eu

APK=${DSH_PAGEOPEN_APK:-hosts/android/app/build/outputs/apk/release/app-release-signed.apk}
PKG=com.dshmobile.spike
OUT=${DSH_PAGEOPEN_OUT:-/tmp/dsh-page-open}
DEADLINE=${DSH_PAGEOPEN_DEADLINE:-120}

say() { echo "run-page-open: $*"; }
die() { echo "::error::run-page-open: $*" >&2; exit 1; }

[ -f "$APK" ] || die "no APK at $APK — build+sign the release flavor first (assembleRelease + apksigner --ks ~/.android/debug.keystore); this check never builds (DSH_PAGEOPEN_APK overrides the path)"

# ---- device + boot, one bounded poll (run-android-full.sh's discipline) ----
deadline=$(( $(date +%s) + 600 ))
until adb get-state >/dev/null 2>&1 &&
      [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    [ "$(date +%s)" -ge "$deadline" ] && die "emulator not booted within 600s"
    sleep 5
done

adb install -r "$APK" >/dev/null || die "adb install failed"
mkdir -p "$OUT"

# ---- fresh boot of the DEFAULT seat (no intent extras — the official serve) --
adb shell am force-stop $PKG >/dev/null 2>&1 || true
adb logcat -c
: > "$OUT/logs.txt"
say "launching the default seat"
adb shell am start -n $PKG/.MainActivity >/dev/null
boot_pid=
deadline=$(( $(date +%s) + 30 ))
while [ -z "$boot_pid" ]; do
    [ "$(date +%s)" -ge "$deadline" ] && die "app process did not start within 30s"
    boot_pid=$(adb shell pidof $PKG | tr -d '\r')
    [ -n "$boot_pid" ] || sleep 1
done

# ---- the serving line: the carrier's port (bounded poll) ---------------------
port=
deadline=$(( $(date +%s) + 60 ))
while [ -z "$port" ]; do
    [ "$(date +%s)" -ge "$deadline" ] && {
        adb logcat -d --pid="$boot_pid" | tail -40 > "$OUT/logs.txt" || true
        die "no 'SessionServe: serving' line within 60s (pid $boot_pid)"
    }
    # The line is Log.i(TAG, "serving dsh-web-official on 127.0.0.1:PORT").
    port=$(adb logcat -d --pid="$boot_pid" 2>/dev/null \
        | grep -o 'serving dsh-web-official on 127\.0\.0\.1:[0-9]*' \
        | head -1 | sed 's/.*://')
    [ -n "$port" ] || sleep 2
done
say "carrier serving on port $port"

# ---- the page url: devtools /json/list, polled until the webview navigates ---
# The devtools socket is per-pid (webview_devtools_remote_<pid>); a tcp forward
# to the abstract socket is the standard WebView debug path (no root needed).
# A passing boot navigates as soon as the probes post settings.probes.done;
# the loop-t bug left the url at '' forever, which is exactly what times out.
fwd=33977
match=
deadline=$(( $(date +%s) + DEADLINE ))
while [ -z "$match" ]; do
    [ "$(date +%s)" -ge "$deadline" ] && {
        adb forward --remove tcp:$fwd >/dev/null 2>&1 || true
        adb logcat -d --pid="$boot_pid" | tail -60 > "$OUT/logs.txt" || true
        die "webview page never opened within ${DEADLINE}s (the settings.probes.done -> maybeOpenOrigin gate is broken again?)"
    }
    if adb forward tcp:$fwd localabstract:webview_devtools_remote_"$boot_pid" >/dev/null 2>&1; then
        # Scan every page-type target for the navigated url: the carrier's own
        # port (not another seat's). maybeOpenOrigin loads ?token=<32 hex>, but
        # the web client replaceState()s the token out of the url after reading
        # it — so accept both the tokened form and the cleaned form; what pins
        # the loop-t regression is the url leaving '' for the carrier origin.
        match=$(curl -s --max-time 5 "http://127.0.0.1:$fwd/json/list" 2>/dev/null \
            | grep -o '"url": *"[^"]*"' | sed 's/"url": *"//;s/"$//' \
            | grep -E "^http://127\.0\.0\.1:$port/(\?token=[0-9a-f]{32})?$" | head -1 || true)
    fi
    [ -n "$match" ] || sleep 1
done
adb forward --remove tcp:$fwd >/dev/null 2>&1 || true
say "page opened: $match"

# ---- zero FAIL lines from this boot (a fail-open pass would hide a producer
# regression on a failing boot; on a passing boot any FAIL is a finding) ------
if adb logcat -d --pid="$boot_pid" 2>/dev/null | grep -Eq "FAIL |scenario\.failed"; then
    adb logcat -d --pid="$boot_pid" | grep -E "FAIL |scenario\.failed" | head -10 > "$OUT/logs.txt" || true
    die "the fresh boot logged a scenario failure — the page opened only through the fail-open path"
fi

echo "$match" > "$OUT/page-url.txt"
adb logcat -d --pid="$boot_pid" > "$OUT/logs-full.txt" 2>/dev/null || true
say "PASS: fresh boot, carrier port $port, page navigated, no FAIL lines"
