#!/bin/sh
# logcat-capture.sh — the shared canary-pinned logcat capture discipline for
# the Android emulator runners (run-upstream-parity.sh, run-dsh-e2e.sh,
# run-android-full.sh, run-upstream-suite.sh, run-live-llm.sh).
#
# The race it pins (measured 2026-09-24 on run-upstream-parity.sh, seen again
# 2026-09-29): `adb logcat -c` races a reader's initial snapshot — lines
# buffered BEFORE the clear (a previous scenario's `dsh.runtime.result: ALL`
# completion tags) can still reach a freshly attached streamer and instantly
# satisfy a completion wait or pollute the truncated capture, before this run
# logged anything. The discipline, proven in run-upstream-parity.sh: a canary
# line the streamer can only see once attached pins the capture point, and
# BOTH the completion wait AND the truncation judge the CANARY VIEW —
# everything from the canary line onward — never the raw stream.
#
# usage:
#   logcat-capture.sh start  [-f FILE] <tag-filter...>
#       Clears the device buffer (`adb logcat -c`), truncates FILE, starts a
#       line-buffered streamer `adb logcat -s <tag-filter...> dsh.canary`
#       appending to FILE (the canary tag is added to the specs automatically
#       — logcat tag specs are EXACT, so `-s dsh.dsh` alone never sees it),
#       emits a unique canary marker onto dsh.canary, and waits (bounded) for
#       that marker to reach FILE — the proof the streamer is attached and
#       everything ahead of the marker is pre-capture. Prints the canary id
#       on stdout; the streamer's pids land in "<FILE>.canary-state".
#   logcat-capture.sh wait [-f FILE] <canary-id> <deadline-seconds> <pattern...>
#       Polls the CANARY VIEW ONLY until EVERY pattern matches (grep BRE, one
#       view pass per round), or the deadline expires. Exit 0 on match, 1 on
#       deadline (or a dead streamer), 2 on usage/config error.
#   logcat-capture.sh view [-f FILE] <canary-id>
#       Prints the canary view — for truncation and ad-hoc greps by runners.
#   logcat-capture.sh stop [-f FILE]
#       Kills the streamer recorded by the last start and removes its state.
#       Idempotent; nonzero only if the streamer refused to die.
#
# The capture file comes from -f FILE or $CAPTURE_FILE (env). Every wait is a
# polled condition with a deadline (rules.md rule 8); every exhaustion is
# loud (rule 5). The adb binary is $DSH_LOGCAT_ADB (default `adb`) so the
# discipline is dry-runnable against a fake stream — `wait`/`view` never
# invoke adb at all, and `start`/`stop` only through that variable.
set -eu

ADB=${DSH_LOGCAT_ADB:-adb}
TAG=dsh.canary
ATTACH_DEADLINE=${CAPTURE_ATTACH_DEADLINE:-60}
STOP_GRACE=${CAPTURE_STOP_GRACE:-5}
POLL_INTERVAL=${CAPTURE_POLL_INTERVAL:-0.2}

usage_die() { die "usage: logcat-capture.sh {start|wait|view|stop} [-f FILE] ... (see the header comment)"; }
die() { echo "::error::logcat-capture: $*" >&2; exit 2; }
loud() { echo "::error::logcat-capture: $*" >&2; exit 1; }

# ---- pure view/join logic (no adb — directly dry-runnable) ------------------

# canary_view <file> <canary-id> — everything from the canary line onward.
# index() over the literal id: same semantics as awk '/<canary-id>/{seen=1}
# seen' without exposing the id to regex interpretation.
canary_view() {
    awk -v canary="$2" 'index($0, canary) { seen = 1 } seen' "$1"
}

# ---- subcommands ------------------------------------------------------------

cmd_start() { # <file> <tag-filter...>
    file=$1
    shift
    [ "$#" -ge 1 ] || die "start: no tag filters given (the tags to stream, e.g. dsh.dsh dsh.runtime.result)"
    [ -d "$(dirname "$file")" ] || die "capture dir missing: $(dirname "$file")"
    : > "$file"

    canary="dsh-canary-$$-$(date +%s)"
    workdir=$(mktemp -d "${TMPDIR:-/tmp}/dsh-logcat-capture.XXXXXX")
    fifo="$workdir/stream"

    # 1. clear BEFORE attaching — and never trust the clear: whatever pierces
    #    it lands before the canary and the view cuts it (the 2026-09-24/29
    #    race). Order is the tightest available: clear, then attach.
    "$ADB" logcat -c >/dev/null 2>&1 || die "adb logcat -c failed"

    # 2. attach the streamer WITH the canary tag in its specs, pump its
    #    stdout into the file line by line (a plain `adb logcat > FILE`
    #    block-buffers: the file only grows in 4KB flushes and the tail
    #    arrives at kill — measured in run-android-full.sh; the fifo pump
    #    keeps marker greps real-time) and keep the adb pid for stop.
    mkfifo "$fifo"
    "$ADB" logcat -s "$@" "$TAG" > "$fifo" 2>/dev/null &
    adb_pid=$!
    # The pump's own stdout/stderr MUST leave the caller's stdout: runners do
    # CANARY=$("$CAPTURE" start ...), and a bg child holding that pipe open
    # would hang the command substitution past the script's exit (measured in
    # the dry run: the substitution never saw EOF). The pump appends via >>,
    # its stdout is unused — null it.
    ( while IFS= read -r line; do printf '%s\n' "$line" >> "$file"; done < "$fifo" ) >/dev/null 2>&1 &
    feeder_pid=$!

    # 3. emit the canary: only an ATTACHED streamer can ever see it — its
    #    arrival in the file is the capture-point proof.
    "$ADB" shell log -t "$TAG" "$canary" >/dev/null

    deadline=$(( $(date +%s) + ATTACH_DEADLINE ))
    until grep -q -- "$canary" "$file"; do
        [ "$(date +%s)" -ge "$deadline" ] &&
            die "logcat streamer never attached (canary $canary unseen within ${ATTACH_DEADLINE}s)"
        sleep "$POLL_INTERVAL"
    done

    printf 'pid=%s\nfeeder=%s\nfifo-dir=%s\ncanary=%s\nfile=%s\n' \
        "$adb_pid" "$feeder_pid" "$workdir" "$canary" "$file" > "${file}.canary-state"
    echo "$canary"
}

cmd_wait() { # <file> <canary-id> <deadline-seconds> <pattern...>
    file=$1; canary=$2; deadline_secs=$3
    shift 3
    [ -n "$canary" ] || die "wait: canary id required (start prints it)"
    [ "$#" -ge 1 ] || die "wait: no patterns given"
    case "$deadline_secs" in
        ''|*[!0-9]*) die "wait: deadline must be a positive integer (seconds), got: $deadline_secs" ;;
    esac
    [ -f "$file" ] || die "wait: capture file missing: $file"

    # The streamer's liveness is checked from THIS process: it is not our
    # child, so no zombie can mask its death. A dead streamer means the
    # capture is frozen — fail loud now instead of burning the deadline on a
    # static file. (No state file, e.g. replaying a saved stream: skip it.)
    state="${file}.canary-state"
    if [ -f "$state" ]; then
        for who in pid feeder; do
            p=$(sed -n "s/^${who}=//p" "$state")
            [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null &&
                loud "streamer $who (pid $p) exited while waiting for canary view ($canary)"
        done
    fi

    viewtmp=$(mktemp "${TMPDIR:-/tmp}/dsh-canary-view.XXXXXX")
    trap 'rm -f "$viewtmp"' EXIT INT TERM
    deadline=$(( $(date +%s) + deadline_secs ))
    while :; do
        canary_view "$file" "$canary" > "$viewtmp"
        ok=1
        for pat in "$@"; do
            grep -q -- "$pat" "$viewtmp" 2>/dev/null || { ok=0; break; }
        done
        [ "$ok" = 1 ] && { rm -f "$viewtmp"; trap - EXIT INT TERM; return 0; }
        [ "$(date +%s)" -ge "$deadline" ] &&
            loud "canary view ($canary) did not match all of [$*] within ${deadline_secs}s"
        if [ -f "$state" ]; then
            for who in pid feeder; do
                p=$(sed -n "s/^${who}=//p" "$state")
                [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null &&
                    loud "streamer $who (pid $p) exited while waiting for canary view ($canary)"
            done
        fi
        sleep "$POLL_INTERVAL"
    done
}

cmd_view() { # <file> <canary-id>
    [ -f "$1" ] || die "view: capture file missing: $1"
    [ -n "$2" ] || die "view: canary id required (start prints it)"
    canary_view "$1" "$2"
}

cmd_stop() { # <file>
    file=$1
    state="${file}.canary-state"
    if [ ! -f "$state" ]; then
        echo "logcat-capture: no streamer state at $state (already stopped?)"
        return 0
    fi
    adb_pid=$(sed -n 's/^pid=//p' "$state")
    feeder_pid=$(sed -n 's/^feeder=//p' "$state")
    workdir=$(sed -n 's/^fifo-dir=//p' "$state")
    kill "$adb_pid" 2>/dev/null || true       # adb's death EOFs the pump
    kill "$feeder_pid" 2>/dev/null || true
    deadline=$(( $(date +%s) + STOP_GRACE ))
    while kill -0 "$adb_pid" 2>/dev/null || kill -0 "$feeder_pid" 2>/dev/null; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            kill -9 "$adb_pid" "$feeder_pid" 2>/dev/null || true
            sleep "$POLL_INTERVAL"
            break
        fi
        sleep "$POLL_INTERVAL"
    done
    if kill -0 "$adb_pid" 2>/dev/null || kill -0 "$feeder_pid" 2>/dev/null; then
        loud "streamer (adb $adb_pid / pump $feeder_pid) refused to die"
    fi
    [ -n "$workdir" ] && [ -d "$workdir" ] && rm -rf "$workdir"
    rm -f "$state"
}

# ---- dispatch: -f FILE before the positionals, else $CAPTURE_FILE -----------

[ "$#" -ge 1 ] || usage_die
cmd=$1
shift
file=""
if [ "${1:-}" = "-f" ]; then
    [ "$#" -ge 2 ] || die "-f needs a path"
    file=$2
    shift 2
fi
[ -n "$file" ] || file=${CAPTURE_FILE:-}
[ -n "$file" ] || die "no capture file (pass -f FILE or export CAPTURE_FILE)"
case "$cmd" in
    start) [ "$#" -ge 1 ] || usage_die; cmd_start "$file" "$@" ;;
    wait)  [ "$#" -ge 3 ] || usage_die; cmd_wait  "$file" "$@" ;;
    view)  [ "$#" -ge 1 ] || usage_die; cmd_view  "$file" "$@" ;;
    stop)  cmd_stop "$file" ;;
    *) usage_die ;;
esac
