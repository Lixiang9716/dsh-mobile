#!/bin/sh
# run-m2-llm.sh — the REAL-backend LLM E2E on the HarmonyOS emulator
# (scenario `m2.llm`, real leg; the W-HARMONY5 leg that closes M5). The twin
# of hosts/android/ci/run-m2-llm.sh, with this host's staging direction
# inverted (see below) and the same capture discipline as
# hosts/harmony/ci/run-host-e2e.sh: build -> install -> verified launch ->
# ONE hilog capture bounded at the completion tag -> pulled capture ->
# checker verdicts -> key-leak grep over the RAW streams.
#
#   1. launch with the leg selected on the command line
#      (`aa start ... --ps dsh.e2e.leg m2.llm` — EntryAbility.onCreate parks
#      it in E2eLeg; harmony has no scenario list to append to, and the
#      default chain stays untouched so `run-host-e2e.sh` never spends serve
#      quota);
#   2. credentials: the app sandbox is NOT shell-writable on this platform.
#      Measured on the dsh_phone emulator: hdc file send can OPEN an existing
#      app-owned file but never CREATE one; an ArkTS-side create lands 0660
#      (unopenable by the shell) and an app-side chmod is a silent no-op. So
#      the RUNTIME creates the placeholder — e2e-stage.js asks the C-side
#      app-scope fsWrite, whose fopen lands 0666 — announces it with the
#      `stage-ready` marker, this script writes the real config over it with
#      `hdc file send`, and the app imports, validates and consumes it
#      (`stage-loaded`). The key never enters a log line, a command line, or
#      the runner's shell history (its temp copy is mode 0600 and deleted
#      immediately); the app removes the imported file when the leg ends,
#      asserted below because the platform's chmod cannot seal it;
#   3. verify the pulled capture against m2-llm-device.json AND
#      m2-llm-carrier.json, then grep the RAW hilog stream and the RAW
#      capture for the API key — it must appear NOWHERE.
#
# Every wait is a polled condition with a deadline (rules.md rule 8); every
# exhaustion is loud (rule 5). The checkers read the PULLED capture file
# (truncation-proof), never hilog.
#
# This driver exits non-zero unless the served turn PASSED: a backend quota
# refusal (HTTP 429) fails the run, it never reads as a green leg (rule 5).
# The live attempt of 2026-09-21T13:15+08:00 hit exactly that — the account's
# coding-plan quota was exhausted (code 1310, reset 2026-09-22 14:43:53) —
# and its capture is committed under artifacts/m5-m2-llm/ as the honest
# transport proof: the request left the device through this host's httpFetch
# and the backend answered. One re-run of this script closes the served-turn
# line once quota returns.
#
# A failed attempt is retried ONLY when the capture proves no request was
# ever attempted (the ArkWeb mount is flaky on the emulator; a retry after a
# real request would spend quota twice). Screen wake + unlock is re-issued
# while waiting: a sleeping screen stalls the ArkWeb mount.
#
# usage: [DSH_SKIP_BUILD=1] hosts/harmony/ci/run-m2-llm.sh [artifacts-dir]
set -eu

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
CLT=${DSH_CLT:-/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools}
HDC="$CLT/sdk/default/openharmony/toolchains/hdc"
OUT=${1:-hosts/harmony/artifacts/m5-m2-llm}
HAP=hosts/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap
BUNDLE=com.dshmobile.spike
BASE=/data/app/el2/100/base/$BUNDLE/haps/entry
CAPTURE_REMOTE=$BASE/cache/dsh-m2-llm-capture.log
CONFIG_REMOTE=$BASE/files/spike-fs/m2-llm/config.json
LEG=m2.llm
STREAM=/tmp/dsh-harmony-m2-llm-hilog.txt
MAX_ATTEMPTS=${DSH_M2_LLM_ATTEMPTS:-2}

say() { echo "run-m2-llm: $*"; }
die() { echo "::error::run-m2-llm: $*" >&2; exit 1; }

# `hdc shell` reports rc=0 whatever the remote command returns (measured), so
# remote state is probed by OUTPUT, never by exit status — a vacuous check is
# worse than none (rule 5/6).
remote_ls() { "$HDC" shell "ls $1 2>/dev/null" | tr -d '\r'; }
remote_exists() { [ -n "$(remote_ls "$1")" ]; }
remote_mode() { "$HDC" shell "ls -l $1" | tr -s ' ' | cut -d' ' -f1 | tr -d '\r'; }
wake_unlock() {
    "$HDC" shell power-shell wakeup >/dev/null 2>&1 || true
    "$HDC" shell uinput -T -m 400 1600 400 400 300 >/dev/null 2>&1 || true
}

# The checkers and the config JSON are built with node; a missing toolchain
# must fail here, not half-way through the run (rule 5).
command -v node >/dev/null 2>&1 || die "node not on PATH (the E2E checkers need it)"

# ---- credentials (env or repo-root .env; fail loud, never print) -----------
if [ -z "${ZAI_API_KEY:-}" ] && [ -f .env ]; then
    . ./.env
fi
[ -n "${ZAI_BASE_URL:-}" ] || die "ZAI_BASE_URL missing (env or .env)"
[ -n "${ZAI_API_KEY:-}" ] || die "ZAI_API_KEY missing (env or .env)"
[ -n "${ZAI_MODEL:-}" ] || die "ZAI_MODEL missing (env or .env)"

# ---- build ------------------------------------------------------------------
if [ "${DSH_SKIP_BUILD:-0}" != "1" ]; then
    hosts/harmony/ci/vendor-official.sh
    (cd hosts/harmony && "$CLT/bin/ohpm" install --all >/dev/null)
    (cd hosts/harmony && "$CLT/bin/hvigorw" assembleHap --mode module \
        -p product=default -p buildMode=debug --no-daemon > /tmp/dsh-harmony-build.log 2>&1) \
        || { echo "::error::hvigorw build failed — see /tmp/dsh-harmony-build.log"; exit 1; }
fi
[ -f "$HAP" ] || die "$HAP missing — build first or unset DSH_SKIP_BUILD"

# ---- device presence + install (bounded polls, rule 8) ----------------------
deadline=$(( $(date +%s) + 120 ))
until "$HDC" list targets | grep -q 127.0.0.1; do
    [ "$(date +%s)" -ge "$deadline" ] && die "no emulator target within 120s (start dsh_phone first)"
    sleep 2
done

tries=0
until "$HDC" install -r "$HAP" >/dev/null 2>&1; do
    tries=$(( tries + 1 ))
    [ "$tries" -ge 5 ] && die "hdc install kept failing"
    sleep 2
done

mkdir -p "$OUT"

# The credentials live in this temp file (0600) only: written once, sent, and
# deleted right after the send. Never echoed (rule 5).
CFG=$(mktemp "${TMPDIR:-/tmp}/dsh-m2-llm-config.XXXXXX")
chmod 600 "$CFG"
printf '{"baseUrl":"%s","apiKey":"%s","model":"%s"}\n' \
    "$ZAI_BASE_URL" "$ZAI_API_KEY" "$ZAI_MODEL" > "$CFG"
streamer=""
cleanup() {
    rm -f "$CFG"
    if [ -n "$streamer" ]; then
        kill "$streamer" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# ---- the launch + staging + verdict sequence, one bounded attempt -----------
# STREAM is (re)pointed per attempt so the checkers only ever see the winning
# attempt's records (a retried attempt would otherwise duplicate carrier
# records and break the one-to-one match).
run_attempt() {
    : > "$STREAM"
    "$HDC" shell hilog > "$STREAM" 2>/dev/null &
    streamer=$!

    deadline=$(( $(date +%s) + 120 ))
    until [ -n "$("$HDC" shell pidof $BUNDLE 2>/dev/null | tr -d '[:space:]')" ]; do
        [ "$(date +%s)" -ge "$deadline" ] && die "$BUNDLE process never appeared within 120s of aa start"
        wake_unlock
        "$HDC" shell aa start -b $BUNDLE -a EntryAbility --ps dsh.e2e.leg $LEG >/dev/null 2>&1 || true
        sleep 3
    done

    # The app must have taken the launch parameter: a mistyped leg would run
    # the default chain (which proves nothing) — fail loud instead.
    deadline=$(( $(date +%s) + 60 ))
    until grep -q "leg $LEG selected at launch" "$STREAM"; do
        [ "$(date +%s)" -ge "$deadline" ] && die "the launch parameter dsh.e2e.leg=$LEG never reached the app"
        sleep 1
    done
    say "leg $LEG selected at launch"

    # Credential handoff: the runtime's placeholder -> send -> import.
    deadline=$(( $(date +%s) + 120 ))
    until grep -q "stage-ready path=" "$STREAM"; do
        if grep -q "stage-error" "$STREAM"; then
            grep "stage-error" "$STREAM" | tail -3
            die "the runtime could not write the config placeholder"
        fi
        [ "$(date +%s)" -ge "$deadline" ] && die "stage-ready never appeared within 120s"
        sleep 1
    done
    remote_exists "$CONFIG_REMOTE" \
        || die "the staged config path does not exist on device ($CONFIG_REMOTE)"
    # The precondition, asserted instead of assumed: the shell user is neither
    # the file's owner nor in the app's group, so only an others-writable
    # placeholder can receive the credentials (rule 5).
    PLACEHOLDER_MODE=$(remote_mode "$CONFIG_REMOTE")
    say "placeholder mode $PLACEHOLDER_MODE"
    if [ "$(printf '%s' "$PLACEHOLDER_MODE" | cut -c9)" != "w" ]; then
        die "the runtime's placeholder is not others-writable ($PLACEHOLDER_MODE) — hdc file send cannot land"
    fi
    SEND_OUT=$("$HDC" file send "$CFG" "$CONFIG_REMOTE" 2>&1) || true
    case "$SEND_OUT" in
        *"[Fail]"*) die "hdc file send refused the config into the app sandbox: $SEND_OUT" ;;
    esac
    rm -f "$CFG"
    say "credentials staged over the placeholder (never printed)"

    deadline=$(( $(date +%s) + 60 ))
    until grep -q "stage-loaded bytes=" "$STREAM"; do
        if grep -q "stage-error" "$STREAM"; then
            grep "stage-error" "$STREAM" | tail -3
            die "the app rejected the staged credentials"
        fi
        [ "$(date +%s)" -ge "$deadline" ] && die "stage-loaded never appeared within 60s of the credential send"
        sleep 1
    done
    grep "stage-loaded bytes=" "$STREAM" | tail -1
    grep -E "stage-sealed|stage-seal ineffective" "$STREAM" | tail -1 || true

    # The verdict, bounded; the screen is re-woken while waiting because a
    # sleeping screen stalls the ArkWeb mount (observed: one attempt died at
    # the mount with no request ever sent).
    deadline=$(( $(date +%s) + 240 ))
    next_wake=0
    while :; do
        grep -q "dsh.spike.verdict: $LEG " "$STREAM" && break
        if [ "$(date +%s)" -ge "$deadline" ]; then
            return 1
        fi
        if [ "$(date +%s)" -ge "$next_wake" ]; then
            next_wake=$(( $(date +%s) + 10 ))
            wake_unlock
        fi
        sleep 1
    done
    sleep 0.5   # let the completion-tag line itself flush
    return 0
}

attempt=1
while :; do
    STREAM=/tmp/dsh-harmony-m2-llm-hilog.txt
    [ "$attempt" -gt 1 ] && STREAM=/tmp/dsh-harmony-m2-llm-hilog.$attempt.txt

    wake_unlock
    "$HDC" shell aa force-stop $BUNDLE >/dev/null 2>&1 || true
    if [ -n "$("$HDC" shell pidof $BUNDLE 2>/dev/null | tr -d '[:space:]')" ]; then
        die "aa force-stop left $BUNDLE resident (pidof non-empty)"
    fi
    "$HDC" shell hilog -r >/dev/null

    if run_attempt; then
        break
    fi

    # No verdict. Decide whether a retry is safe: a request may already have
    # left the device (llm.stream.started in the capture), in which case a
    # retry would spend quota twice — never.
    "$HDC" file recv "$CAPTURE_REMOTE" /tmp/dsh-m2-llm-attempt-capture.txt >/dev/null 2>&1 || true
    if grep -q '"event":"llm.stream.started"' /tmp/dsh-m2-llm-attempt-capture.txt 2>/dev/null; then
        kill "$streamer" 2>/dev/null || true
        streamer=""
        die "no verdict after the request was attempted (quota may have been spent) — NOT retrying"
    fi
    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
        kill "$streamer" 2>/dev/null || true
        streamer=""
        echo "::error::scenario $LEG did not complete after $attempt attempt(s) and no request was attempted"
        tail -40 "$STREAM"
        die "the phase never reached a verdict"
    fi
    say "attempt $attempt: no verdict and no request attempted (mount flake?) — relaunching"
    kill "$streamer" 2>/dev/null || true
    streamer=""
    attempt=$(( attempt + 1 ))
done

# Supplementary screenshot (E2E by logs: never an assertion, evidence only).
"$HDC" shell snapshot_display -f /data/local/tmp/dsh-m2-llm.jpeg >/dev/null 2>&1 || true
"$HDC" file recv /data/local/tmp/dsh-m2-llm.jpeg "$OUT/m2-llm-live-page.jpeg" >/dev/null 2>&1 \
    || say "screenshot unavailable (non-fatal)"
if [ -f "$OUT/m2-llm-live-page.jpeg" ]; then
    sips -s format png "$OUT/m2-llm-live-page.jpeg" --out "$OUT/m2-llm-live-page.png" >/dev/null
    rm -f "$OUT/m2-llm-live-page.jpeg"
fi

kill "$streamer" 2>/dev/null || true
wait "$streamer" 2>/dev/null || true
streamer=""
trap cleanup EXIT INT TERM

grep 'dsh.spike' "$STREAM" > "$OUT/logs.txt" || true
grep "dsh.spike.verdict: $LEG " "$STREAM" > "$OUT/results.txt" || true
cat "$OUT/results.txt"

# The truncation-proof second capture: the app's own sink file, pulled from
# the sandbox (same convention as run-host-e2e.sh).
"$HDC" file recv "$CAPTURE_REMOTE" "$OUT/capture.txt" >/dev/null
grep '^dsh.spike.log:' "$OUT/capture.txt" > "$OUT/scenario.jsonl"

# ---- the key-leak re-check over the RAW streams -----------------------------
# First, before any verdict check: a leak is the one failure that must be
# reported no matter how the run ended (the refusals below would mask it).
if grep -qF "$ZAI_API_KEY" "$OUT/logs.txt"; then
    die "THE API KEY APPEARED IN THE CAPTURED HILOG STREAM"
fi
if grep -qF "$ZAI_API_KEY" "$OUT/capture.txt"; then
    die "THE API KEY APPEARED IN THE PULLED CAPTURE"
fi
say "key-leak re-check clean (raw hilog stream + raw capture carry no API key)"

# The credentials must be gone once the leg is done: this platform's chmod is
# a silent no-op on the handshake file, so the app DELETES it when the leg
# ends (LlmConfigStaging.cleanup) — asserted here, not assumed (rule 5).
if remote_exists "$CONFIG_REMOTE"; then
    die "the app did not remove the staged credentials after the run ($CONFIG_REMOTE)"
fi
say "credentials removed by the app after the run"

# ---- E2E by logs: one checker verdict per manifest --------------------------
# Run BOTH checkers whatever the verdict tag said, so the artifacts always
# carry the precise expected<->logged diff (a blocked run's whole diagnosis
# lives in those two files), then assert on both legs of the acceptance: the
# scenario's own verdict line AND each checker's pass field.
node test/e2e/check.mjs --manifest test/e2e/scenarios/m2-llm-device.json \
    --log "$OUT/capture.txt" --out "$OUT/verdict-m2-llm-device.json" || true
cat "$OUT/verdict-m2-llm-device.json"
node test/e2e/check.mjs --manifest test/e2e/scenarios/m2-llm-carrier.json \
    --log "$OUT/capture.txt" --out "$OUT/verdict-m2-llm-carrier.json" || true
cat "$OUT/verdict-m2-llm-carrier.json"

grep "dsh.spike.verdict: $LEG " "$OUT/results.txt" | grep -q " PASS" \
    || die "the scenario verdict is not PASS — see $OUT/results.txt"
for v in "$OUT/verdict-m2-llm-device.json" "$OUT/verdict-m2-llm-carrier.json"; do
    grep -q '"pass": true' "$v" || die "$(basename "$v") is not a PASS verdict"
done
say "m2.llm real-backend leg complete — evidence under $OUT"
