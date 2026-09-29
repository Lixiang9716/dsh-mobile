#!/usr/bin/env bash
# hosts/ios/Tools/sim-preflight.sh — simulator runtime preflight for the iOS
# E2E runners (P1: the iOS 18.5 runtime trap).
#
# WHY: the iOS 18.5 simulator runtime's dyld shared cache does not carry
# libswiftWebKit, so DSHSpike.debug.dylib dies AT LAUNCH with
# "Library not loaded: @rpath/libswiftWebKit.dylib". Every runner in
# test/e2e/run-ios-*.sh builds happily against such a destination and then
# burns its whole budget on a launch that can never produce app logs. The
# proven pairing is the 'dsh-iphone' simulator on iOS 26.5. Called one line
# before each runner's boot/install step, this fails LOUD (gov rules.md §5)
# with the offending runtime instead of letting the run die at launch.
#
# usage: sim-preflight.sh [UDID]
#   UDID positional; defaults to $DSH_E2E_UDID (the runners' own default).
#
#   SIM_PREFLIGHT_DEVICES_JSON — when set, replaces the live
#   `xcrun simctl list -j devices` output. The listing is a PARAMETER so the
#   rejection path is assertable on machines with no pre-26 runtime installed
#   (and so the check is testable without booting anything).
#
# exit: 0 runtime OK (prints it) · 1 runtime too old / device missing /
#         listing unusable · 2 usage
set -euo pipefail

MIN_MAJOR=26   # oldest simulator runtime whose dyld cache carries libswiftWebKit

usage() { echo "usage: sim-preflight.sh [UDID]   (default: \$DSH_E2E_UDID)" >&2; exit 2; }

[ $# -le 1 ] || usage
UDID="${1:-${DSH_E2E_UDID:-}}"
[ -n "$UDID" ] || { echo "sim-preflight: FAIL: no UDID argument and DSH_E2E_UDID is unset" >&2; exit 2; }

LISTING="${SIM_PREFLIGHT_DEVICES_JSON:-}"
if [ -z "$LISTING" ]; then
  LISTING="$(xcrun simctl list -j devices)" \
    || { echo "sim-preflight: FAIL: 'xcrun simctl list -j devices' failed" >&2; exit 1; }
fi
[ -n "$LISTING" ] || { echo "sim-preflight: FAIL: empty simulator listing" >&2; exit 1; }

SIM_PREFLIGHT_LISTING="$LISTING" python3 - "$UDID" "$MIN_MAJOR" <<'PY'
import json, os, sys

udid, min_major = sys.argv[1], int(sys.argv[2])
try:
    devices = json.loads(os.environ["SIM_PREFLIGHT_LISTING"])["devices"]
except Exception as exc:
    print(f"sim-preflight: FAIL: cannot parse the simulator listing: {exc}", file=sys.stderr)
    sys.exit(1)

def parse_rt(key):  # com.apple.CoreSimulator.SimRuntime.iOS-26-5 -> ("iOS", [26, 5])
    parts = key.rsplit("SimRuntime.", 1)[-1].split("-")
    return parts[0], parts[1:]

def pretty_rt(key):
    fam, nums = parse_rt(key)
    return fam + " " + ".".join(nums)

hit = next(((k, d) for k, ds in devices.items() for d in ds
            if d.get("udid") == udid), None)
if hit is None:
    print(f"sim-preflight: FAIL: no simulator with UDID {udid} in simctl list "
          f"(pass --udid or set DSH_E2E_UDID to an existing device)", file=sys.stderr)
    sys.exit(1)

rt_key, dev = hit
fam, nums = parse_rt(rt_key)
name = dev.get("name", "?")
if fam != "iOS" or not nums or not nums[0].isdigit():
    print(f"sim-preflight: FAIL: device '{name}' ({udid}) runs {pretty_rt(rt_key)!r}, "
          f"not an iOS runtime — DSHSpike pairs with iOS >= {min_major}", file=sys.stderr)
    sys.exit(1)

major = int(nums[0])
if major < min_major:
    ok = sorted({pretty_rt(k) for k in devices
                 if parse_rt(k)[0] == "iOS" and parse_rt(k)[1]
                 and parse_rt(k)[1][0].isdigit() and int(parse_rt(k)[1][0]) >= min_major})
    have = ok if ok else ["(none installed)"]
    print(f"sim-preflight: FAIL: device '{name}' (UDID {udid}) runs {pretty_rt(rt_key)} — "
          f"DSHSpike needs iOS >= {min_major}.\n"
          f"  The pre-26 runtime's dyld shared cache lacks libswiftWebKit (observed on "
          f"18.5), so DSHSpike.debug.dylib dies at launch with 'Library not loaded' — the "
          f"run would burn its whole budget on a launch that can never produce logs.\n"
          f"  Proven pairing: the 'dsh-iphone' simulator on iOS 26.5.\n"
          f"  Fix: point --udid / DSH_E2E_UDID at a device on: {', '.join(have)}",
          file=sys.stderr)
    sys.exit(1)

print(f"sim-preflight: OK: {name} ({udid}) on {pretty_rt(rt_key)} (>= {min_major})")
PY
