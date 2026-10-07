#!/usr/bin/env bash
# run.sh — the Android half of the release-logging evidence: prove the ABSENCE
# of test machinery in the user-facing build, and the PRESENCE of it in the
# harness.
#
# Release (dsh-android): a plain launch — NO extras, NOTHING staged from
# outside — must reach the official DSH Web UI (the dist + client bundles are
# EMBEDDED in the APK's assets), emit ZERO `dsh.spike.log:` records, ZERO
# `"level":"debug"`/`"level":"info"` records, ZERO verdict text, and ZERO
# `dsh.gateway.audit:` lines. An E2E drive asked for by extra must be REFUSED
# BY NAME (rules.md rule 5).
# Debug (dsh-android-harness): the same plain launch must still produce the
# full structured E2E stream — the harness evidence cannot regress, and its
# stream is what makes the release's zero counts meaningful (the capture
# channel is proven live by the contrast, not assumed).
#
# SIGNING: the shipped release artifact is `app-release-unsigned.apk` (what
# release.yml uploads); it does not install. This script signs a COPY locally
# with the debug keystore so the emulator will take it. That signing is a
# LOCAL VERIFICATION STEP ONLY — it says nothing about the shipped artifact's
# state, which stays unsigned until the user signs it with their own key
# (docs/release.md). The signed copy lands in $VERIFY_DIR, outside the
# repository.
#
# usage: hosts/android/artifacts/release-logging/run.sh [--skip-build]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
ART="$ROOT/hosts/android/artifacts/release-logging"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
export JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/microsoft-17.jdk/Contents/Home}"
NODE_BIN="$HOME/.nvm/versions/node/v24.14.0/bin"
SERIAL="${DSH_E2E_SERIAL:-emulator-5554}"
APP_ID=com.dshmobile.spike
ACTIVITY="$APP_ID/.MainActivity"
BT="${DSH_BUILD_TOOLS:-$ANDROID_HOME/build-tools/34.0.0}"
APK_REL="$ROOT/hosts/android/app/build/outputs/apk/release/app-release-unsigned.apk"
APK_DBG="$ROOT/hosts/android/app/build/outputs/apk/debug/app-debug.apk"
VERIFY_DIR="${DSH_VERIFY_DIR:-/tmp/dsh-release-verify}"
SIGNED="$VERIFY_DIR/app-release-verify-signed.apk"
# How long the single launch is observed before the logcat dump is read. The
# harness reference below reaches its LAST record ~15 s after `am start`, so
# 25 s covers the whole reference stream with margin; the wait is paced on
# REAL conditions first (carrier listening, page fetching, seat answering) —
# this hold only bounds the observation window, it awaits no state.
OBSERVE_SECONDS="${DSH_OBSERVE_SECONDS:-25}"
SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

mkdir -p "$ART" "$VERIFY_DIR"
log() { echo "release-logging(android): $*"; }
die() { echo "release-logging(android): FAIL: $*" >&2; exit 1; }

adb_() { adb -s "$SERIAL" "$@"; }
count() { # $1 = file, $2 = fixed string
  grep -c -F "$2" "$1" 2>/dev/null || true
}
# The app's uid, read off its own process — the /proc/net socket tables carry
# the uid, which is how the carrier's loopback listener is identified below.
app_uid() {
  local pid
  pid="$(adb_ shell pidof "$APP_ID" 2>/dev/null | tr -d '\r')"
  [ -n "$pid" ] || return 1
  adb_ shell "stat -c %u /proc/$pid" 2>/dev/null | tr -d '\r'
}

# Wait on conditions, never clocks (rules.md rule 8): liveness + boot
# completion polled together with one deadline, loud on exhaustion.
log "waiting for $SERIAL (sys.boot_completed=1)"
deadline=$(( SECONDS + 300 ))
until [ "$(adb_ shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  [ "$SECONDS" -lt "$deadline" ] ||
    die "$SERIAL never reported sys.boot_completed within 300s"
  sleep 5
done

if [ "$SKIP_BUILD" -eq 0 ]; then
  log "materializing the untracked trees the release APK embeds"
  for s in runtime/spike/vendor/ensure-dsh.sh tools/e2e/ensure-official-dist.sh \
           tools/e2e/ensure-client-bundles.sh; do
    PATH="$NODE_BIN:$PATH" bash "$s" || die "$s failed"
  done
  log "gradlew assembleRelease (the user-facing build)"
  (cd hosts/android && ./gradlew assembleRelease --no-daemon 2>&1 | tail -3)
  log "gradlew assembleDebug (the harness)"
  (cd hosts/android && ./gradlew assembleDebug --no-daemon 2>&1 | tail -3)
fi

# ---- the shipped artifact: name, signing state, embedded assets -------------
[ -f "$APK_REL" ] || die "release APK missing: $APK_REL"
[ -f "$APK_DBG" ] || die "harness APK missing: $APK_DBG"
# One listing, read twice: `unzip -l … | grep -q` exits the pipeline early and
# pipefail then fails a check that SUCCEEDED (hit while authoring this script).
unzip -l "$APK_REL" > "$ART/apk-release-listing.txt"
DIST_N="$(grep -c 'assets/official-web/' "$ART/apk-release-listing.txt" || true)"
PLUGINS_N="$(grep -c 'assets/web-plugins/' "$ART/apk-release-listing.txt" || true)"
SPIKE_N="$(grep -c 'assets/spike/' "$ART/apk-release-listing.txt" || true)"
{
  echo "# release.yml ships hosts/android/app/build/outputs/apk/release/app-release-unsigned.apk"
  ls -l "$APK_REL" "$APK_DBG"
  echo
  echo "## the shipped release APK is UNSIGNED (expected: DOES NOT VERIFY)"
  "$BT/apksigner" verify "$APK_REL" 2>&1 || true
  echo
  echo "## embedded assets inside the release APK (unzip -l)"
  echo "assets/official-web entries:   $DIST_N"
  echo "assets/web-plugins entries:    $PLUGINS_N"
  echo "assets/spike entries:          $SPIKE_N"
  grep -E "assets/official-web/dist/index.html|assets/spike/scenario/b-android-web-live.js|assets/spike/logger.js" \
    "$ART/apk-release-listing.txt"
} > "$ART/apk-release-contents.txt"
grep -q "DOES NOT VERIFY" "$ART/apk-release-contents.txt" ||
  die "the shipped release APK is signed — release.yml ships it unsigned"
[ "$DIST_N" -eq 89 ] ||
  die "the release APK does not embed the official dist (expect 89 files, got $DIST_N)"
[ "$PLUGINS_N" -eq 129 ] ||
  die "the release APK does not embed the client bundles (expect 129 files, got $PLUGINS_N)"
grep -q "assets/spike/logger.js" "$ART/apk-release-listing.txt" ||
  die "the release APK does not embed the spike bundle"

# ---- local verification signing (NOT the shipped artifact's state) ---------
log "signing a COPY with the debug keystore — local verification only"
"$BT/apksigner" sign --ks "$HOME/.android/debug.keystore" \
  --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey --out "$SIGNED" "$APK_REL"
"$BT/apksigner" verify --print-certs "$SIGNED" > "$ART/signing.txt" 2>&1
grep -q "CN=Android Debug" "$ART/signing.txt" ||
  die "the verification copy was not signed with the debug keystore"
{
  echo "# LOCAL VERIFICATION SIGNING — not the shipped artifact's state"
  echo "# release.yml uploads app-release-unsigned.apk; the emulator needs a"
  echo "# signed APK, so a COPY was signed with ~/.android/debug.keystore:"
  echo "#   apksigner sign --ks ~/.android/debug.keystore --ks-pass pass:android \\"
  echo "#     --key-pass pass:android --ks-key-alias androiddebugkey \\"
  echo "#     --out $SIGNED $APK_REL"
  cat "$ART/signing.txt"
} > "$ART/signing.txt.tmp" && mv "$ART/signing.txt.tmp" "$ART/signing.txt"

# ---- launch helpers ---------------------------------------------------------

# The release boot has NO completion tag (no verdict exists in a user-facing
# build), so its outcome is proved by REAL conditions instead: the carrier
# listener owned by the app uid, a page connection to that listener, and the
# dist seat answering the auth-lite gate on the loopback origin.
launch_plain() { # $1 = apk, $2 = tag
  local apk="$1" tag="$2"
  adb_ shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
  adb_ uninstall "$APP_ID" >/dev/null 2>&1 || true
  adb_ install -r "$apk" >/dev/null 2>&1 || die "install failed for $tag"
  adb_ logcat -c || die "logcat -c failed (the absence assertions need a clean window)"
  adb_ shell am start -n "$ACTIVITY" >/dev/null || die "am start failed for $tag"
  local d=$((SECONDS+90))
  until adb_ shell pidof "$APP_ID" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$d" ] || die "$tag: the app process never came up"
    sleep 2
  done
}

# The carrier's loopback listener, found in the kernel socket tables by the
# app's uid (the release build is not debuggable, so /proc is the only
# process-side view available — and it needs no app cooperation at all).
carrier_port() { # -> hex port on stdout, e.g. 9747
  local uid="$1" line
  line="$(adb_ shell "cat /proc/net/tcp /proc/net/tcp6" 2>/dev/null |
    awk -v u="$uid" '$4=="0A" && $8==u {print $2}' | head -1 | tr -d '\r')"
  [ -n "$line" ] || return 1
  echo "${line##*:}"
}
log "launch 1/3 — dsh-android (release), plain launch, nothing staged"
launch_plain "$SIGNED" plain-launch-release
uid="$(app_uid)" || die "could not read the app uid"
deadline=$((SECONDS+90)); port=""
until port="$(carrier_port "$uid")"; do
  [ "$SECONDS" -lt "$deadline" ] ||
    die "the release boot never bound the loopback carrier (no LISTEN socket for uid $uid)"
  sleep 3
done
log "carrier listening on 127.0.0.1:$((16#$port)) (uid $uid)"
# The page connected to the carrier → the WebView really fetched the origin.
# Read off the REMOTE address column and required to be a non-LISTEN row: the
# listener's own row carries the port in its LOCAL address, so a plain grep
# for the port would match the listener and prove nothing.
deadline=$((SECONDS+90)); fetched=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ "$(adb_ shell "cat /proc/net/tcp /proc/net/tcp6" 2>/dev/null |
         awk -v p="$port" '$4!="0A" && $3 ~ (":" p "$")' | wc -l | tr -d ' ')" -gt 0 ]; then
    fetched=1
    break
  fi
  sleep 3
done
[ "$fetched" -eq 1 ] ||
  die "no page connection to the carrier port — the WebView never fetched the origin"
log "the page fetched the origin (a connection to 127.0.0.1:$((16#$port)) exists)"
# The dist seat answers the auth-lite gate: 401 without the session cookie IS
# the official index seat serving (a dead origin would refuse the connection).
adb_ forward "tcp:48045" "tcp:$((16#$port))" >/dev/null
PROBE="$(curl -s -o /dev/null -w 'status=%{http_code} bytes=%{size_download}' http://127.0.0.1:48045/ || true)"
adb_ forward --remove tcp:48045 >/dev/null 2>&1 || true
{
  echo "# the release boot's served origin, probed through adb forward"
  echo "carrier_port=$((16#$port)) uid=$uid"
  echo "page connections to the carrier: $(adb_ shell "cat /proc/net/tcp /proc/net/tcp6" 2>/dev/null | awk -v p="$port" '$4!="0A" && $3 ~ (":" p "$")' | wc -l | tr -d ' ')"
  echo "GET / -> $PROBE   (401 = the auth-lite token gate of the official dist seat)"
  echo "launcher focus: $(adb_ shell dumpsys window 2>/dev/null | grep -m1 mCurrentFocus | tr -d '\r')"
} > "$ART/origin-release.txt"
grep -q "status=401" "$ART/origin-release.txt" ||
  die "the dist seat did not answer 401 on the loopback origin (got: $PROBE)"

sleep "$OBSERVE_SECONDS"   # bounds the observation window; awaits no state
adb_ exec-out screencap -p > "$ART/plain-launch-release.png"
adb_ logcat -d -s dsh.spike dsh.spike.result > "$ART/plain-launch-release.logcat.txt" 2>&1 || true
adb_ logcat -d --pid="$(adb_ shell pidof "$APP_ID" | tr -d '\r')" \
  > "$ART/plain-launch-release.app.logcat.txt" 2>&1 || true

for f in "$ART/plain-launch-release.logcat.txt" "$ART/plain-launch-release.app.logcat.txt"; do
  [ "$(count "$f" 'dsh.spike.log:')" -eq 0 ] ||
    die "the release emitted an E2E record ($f)"
  [ "$(count "$f" '"level":"debug"')" -eq 0 ] ||
    die "the release emitted a debug record ($f)"
  [ "$(count "$f" '"level":"info"')" -eq 0 ] ||
    die "the release emitted an info record ($f)"
  [ "$(count "$f" 'dsh.gateway.audit:')" -eq 0 ] ||
    die "the release emitted a gateway audit line ($f)"
  [ "$(count "$f" 'dsh.spike.result')" -eq 0 ] ||
    die "the release emitted verdict text ($f)"
  [ "$(count "$f" 'ALL PASS')" -eq 0 ] && [ "$(count "$f" 'ALL FAIL')" -eq 0 ] ||
    die "the release emitted a scenario verdict ($f)"
done
# The harness processes it must not be: the release carries no debuggable
# flag, so the harness-only capture vehicle is unavailable by construction.
if adb_ shell run-as "$APP_ID" ls files >/dev/null 2>&1; then
  die "the release build is debuggable (run-as works) — it must not be"
fi
log "release: 0 E2E records / 0 debug+info / 0 verdict / 0 audit"

# ---- the refusal (rules.md rule 5) -----------------------------------------
log "launch 2/3 — dsh-android asked for an E2E drive: must refuse BY NAME"
adb_ shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
adb_ logcat -c
adb_ shell am start -n "$ACTIVITY" --ez dsh.llm true >/dev/null ||
  die "am start with the drive extra failed to dispatch"
deadline=$((SECONDS+60))
until adb_ logcat -d 2>/dev/null | grep -q "release build: refusing"; do
  [ "$SECONDS" -lt "$deadline" ] ||
    die "the release build did not refuse the dsh.llm drive within 60s"
  sleep 2
done
adb_ logcat -d > "$ART/refusal.logcat.txt" 2>&1 || true
grep -q "release build: refusing 'dsh.llm'" "$ART/refusal.logcat.txt" ||
  die "the refusal does not name the offending drive"
[ "$(count "$ART/refusal.logcat.txt" 'dsh.spike.log:')" -eq 0 ] ||
  die "the refusal window leaked E2E records"
log "refused by name: $(grep -m1 -o "refusing 'dsh.llm'" "$ART/refusal.logcat.txt")"

# ---- the harness contrast ---------------------------------------------------
log "launch 3/3 — dsh-android-harness (debug), the same plain launch"
adb_ shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
adb_ uninstall "$APP_ID" >/dev/null 2>&1 || true
adb_ install -r "$APK_DBG" >/dev/null 2>&1 || die "install failed for the harness"
adb_ logcat -c
adb_ shell am start -n "$ACTIVITY" >/dev/null || die "am start failed for the harness"
: > "$ART/plain-launch-harness.logcat.txt"
deadline=$((SECONDS+300)); completed=0
while [ "$SECONDS" -lt "$deadline" ]; do
  adb_ logcat -d -s dsh.spike dsh.spike.result > "$ART/plain-launch-harness.logcat.txt" 2>/dev/null || true
  if grep -q "ALL PASS\|ALL FAIL" "$ART/plain-launch-harness.logcat.txt"; then completed=1; break; fi
  sleep 5
done
[ "$completed" -eq 1 ] || die "the harness never reached a completion tag"
adb_ exec-out screencap -p > "$ART/plain-launch-harness.png"
HARNESS_RECORDS="$(count "$ART/plain-launch-harness.logcat.txt" 'dsh.spike.log:')"
[ "$HARNESS_RECORDS" -gt 0 ] ||
  die "the harness emitted no E2E records — its evidence regressed"
HARNESS_DEBUG="$(count "$ART/plain-launch-harness.logcat.txt" '"level":"debug"')"
HARNESS_INFO="$(count "$ART/plain-launch-harness.logcat.txt" '"level":"info"')"
grep -q "ALL PASS" "$ART/plain-launch-harness.logcat.txt" || die "the harness did not pass"

log "release: 0 E2E records / 0 debug / 0 info / 0 verdict / 0 audit; \
harness: $HARNESS_RECORDS E2E records ($HARNESS_DEBUG debug, $HARNESS_INFO info)"
log "artifacts in $ART"
