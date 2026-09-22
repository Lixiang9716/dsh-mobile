#!/usr/bin/env python3
"""ios-ui — drive the iOS simulator's DSH app by LABEL, through WebDriverAgent.

Backend: the WebDriverAgent this repository already knows how to bootstrap
(test/e2e/run-ios.sh `wda_bootstrap`, appium/WebDriverAgent on localhost:8100).
It publishes the COMPLETE accessibility tree of the WKWebView — the thing idb
cannot do here: `idb ui describe-all` returns only the app root, so idb can
only be driven by sampling points (~20s per screen) and gets a coordinate wrong
the moment the page re-lays-out. WDA answers the whole tree in one call (~1s),
with frames in the same coordinate space idb taps use.

Measured lessons baked in:

* A coordinate is stale the moment the page changes — a growing transcript
  moves the composer, and the top safe-area inset moved the whole page 62pt —
  so every action re-reads the tree rather than caching a point.
* WDA's `/element/:id/click` returns success but does NOT dispatch into a
  WKWebView; a coordinate press through `wda/dragfromtoforduration` does.
* `idb ui text` types ~1s per character over the idb protocol and blocks the
  input path, which a human typing in the Simulator queues behind — it presents
  as "the app hangs when the cursor is in the input". Text goes in through the
  element value endpoint, which is O(1).
* The simulator display can freeze after repeated install/launch cycles:
  `shot --check` reports it and `recover` reboots the device.

usage:
  ios-ui.py scan                      # actionable controls: label, type, center
  ios-ui.py tap "<label>"             # click by label (coordinate press)
  ios-ui.py type "<text>"             # set the focused field's value
  ios-ui.py shot <path> [--check]
  ios-ui.py wait "<label>" [--secs N]
  ios-ui.py sweep <dir>               # tap every control, before/after shots
  ios-ui.py logs [minutes] | recover | launch | status
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

UDID_DEFAULT = os.environ.get("DSH_E2E_UDID", "A4AE41BF-026A-441E-85DF-F53522996073")
BUNDLE = "org.dsh.DSHSpike"
WDA = "http://localhost:8100"
EDITABLE = ("TextField", "TextArea", "SecureTextField", "SearchField", "TextView")
ACTIONABLE = {
    "Button", "TextField", "TextArea", "SecureTextField", "SearchField",
    "Link", "Cell", "Toggle", "Switch", "TextView", "MenuItem", "PopUpButton",
    "Other",
}
# `Other` is actionable here because the DSH shell renders several real
# controls as `Other` (the settings gear, the workspace chip, the add-file
# button). The filter that keeps the list honest is a non-empty LABEL.


def http(method, path, body=None, timeout=25):
    req = urllib.request.Request(
        WDA + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as rsp:
            raw = rsp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        # WDA answers 404 both for "no such element" and for a stale session
        # (the app relaunched under it). Both are normal here and both are the
        # caller's business, so they come back as a value, not a crash.
        return {"__status": err.code}
    return json.loads(raw) if raw.strip().startswith(("{", "[")) else raw


def wda_up():
    try:
        status = http("GET", "/status", timeout=4).get("value", {})
        return status.get("state") == "success"
    except Exception:
        return False


_SESSION = None


def session(fresh=False):
    global _SESSION
    if fresh or _SESSION is None:
        _SESSION = http("POST", "/session", {"capabilities": {}}).get("sessionId")
    return _SESSION


def tree():
    """The accessibility tree of the frontmost app, flattened."""
    payload = http("GET", "/source?format=json", timeout=40)
    root = payload.get("value", payload) if isinstance(payload, dict) else payload
    out = []

    def walk(node, depth=0):
        out.append({"type": node.get("type") or "",
                    "label": (node.get("label") or node.get("name") or "") or "",
                    "value": node.get("value") or "",
                    "frame": node.get("frame") or "",
                    "depth": depth})
        for child in (node.get("children") or []):
            walk(child, depth + 1)

    walk(root)
    return out


def parse_frame(frame):
    """'{{x, y}, {w, h}}' -> (x, y, w, h) or None."""
    try:
        origin, size = frame.strip().strip("{}").split("},")
        x, y = [int(float(v.strip().strip("{}"))) for v in origin.split(",")]
        w, h = [int(float(v.strip().strip("{}"))) for v in size.split(",")]
        return x, y, w, h
    except Exception:
        return None


def controls():
    """Actionable, labelled controls with their tap centres (WDA backend)."""
    found, seen = [], set()
    for node in tree():
        if node["type"] not in ACTIONABLE or not node["label"].strip():
            continue
        box = parse_frame(node["frame"])
        if not box or (node["type"], box) in seen:
            continue
        seen.add((node["type"], box))
        x, y, w, h = box
        found.append({"label": node["label"].strip(), "type": node["type"],
                      "center": [round(x + w / 2), round(y + h / 2)],
                      "frame": box})
    return found


def find(needle, exact=False):
    return [c for c in controls()
            if (c["label"] == needle if exact else needle in c["label"])]


def press(center, duration=0.1):
    """One coordinate press through WDA (the reliable path for web content)."""
    cx, cy = center
    http("POST", f"/session/{session()}/wda/dragfromtoforduration",
         {"fromX": cx, "fromY": cy, "toX": cx, "toY": cy, "duration": duration})


def tap(needle, hold=1.2):
    hits = find(needle)
    if not hits:
        print(f"NOT FOUND: {needle!r}")
        return 1
    hit = hits[0]
    press(hit["center"])
    time.sleep(hold)
    print(f"tapped {hit['label']!r} ({hit['type']}) at {hit['center']}")
    return 0


def element_for_type(kind):
    """The WDA element handle for the first element of `kind`, or None."""
    sid = session()
    out = http("POST", f"/session/{sid}/element",
               {"using": "xpath", "value": f"//XCUIElementType{kind}"})
    val = out.get("value")
    if isinstance(val, dict):
        return sid, val.get("ELEMENT")
    if isinstance(val, list) and val:
        return sid, val[0].get("ELEMENT")
    return sid, None


def type_text(text, hold=1.0):
    """Set the focused field's value (O(1), not per-character injection).

    Lookup is by element TYPE, not label: the composer's label is its
    placeholder while empty and its content once typed, so a label lookup is
    unstable, and a re-render can drop the node from a single tree read.
    """
    for _attempt in range(3):
        for node in [n for n in tree() if n["type"] in EDITABLE]:
            sid, eid = element_for_type(node["type"])
            if not eid:
                continue
            http("POST", f"/session/{sid}/element/{eid}/value",
                 {"text": text, "value": list(text)})
            time.sleep(hold)
            print(f"typed into {node['type']} via xpath")
            return 0
        time.sleep(1)
    print("no editable field found")
    return 1


def shot(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    subprocess.run(["xcrun", "simctl", "io", UDID_DEFAULT, "screenshot", path],
                   capture_output=True, timeout=60)
    with open(path, "rb") as fh:
        return hashlib.sha1(fh.read()).hexdigest()[:10]


def sweep_one(ctl, out_dir, index, hold):
    """Tap one control and capture its before/after evidence."""
    slug = f"{index:02d}-" + "".join(
        ch if ch.isalnum() else "_" for ch in ctl["label"])[:24]
    before = shot(os.path.join(out_dir, f"{slug}-before.png"))
    press(ctl["center"])
    time.sleep(hold)
    after = shot(os.path.join(out_dir, f"{slug}-after.png"))
    return {"label": ctl["label"], "type": ctl["type"], "center": ctl["center"],
            "changed": before != after,
            "evidence": [f"{slug}-before.png", f"{slug}-after.png"]}


def sweep_next(all_controls, done):
    """The next control the sweep has not visited, top-to-bottom."""
    fresh = [c for c in all_controls if (c["label"], tuple(c["frame"])) not in done]
    if not fresh:
        return None
    return sorted(fresh, key=lambda c: (c["center"][1], c["center"][0]))[0]


def sweep(out_dir, hold=1.5, max_controls=60):
    """Tap every actionable control once, with before/after screenshots.

    ONE control per scan. Measured with a coordinate backend: batching taps
    from a single scan produced a checklist where nine of eleven controls read
    "no-op" — the first tap navigated, the page re-laid-out, and every later
    tap fired at a coordinate that no longer held its control. A scan is ~1s
    with WDA, so re-reading the tree per control costs nothing.
    """
    os.makedirs(out_dir, exist_ok=True)
    rows, done = [], set()
    while len(rows) < max_controls:
        ctl = sweep_next(controls(), done)
        if ctl is None:
            break
        done.add((ctl["label"], tuple(ctl["frame"])))
        if not 8 <= ctl["center"][1] <= 866:
            # Off-screen (the tree reports negative frames for content scrolled
            # above the viewport): a press there lands on whatever sits at that
            # edge, so the control is recorded as present-but-unreachable
            # rather than given a fake verdict.
            rows.append(dict(ctl, changed=False, evidence=[],
                             skipped="off-screen (needs scrolling)"))
            print(f"off-screen {ctl['type']:12} {str(ctl['center']):12} {ctl['label'][:34]}")
        else:
            row = sweep_one(ctl, out_dir, len(rows), hold)
            rows.append(row)
            print(f"{'CHANGED' if row['changed'] else 'no-op  '} "
                  f"{ctl['type']:12} {str(ctl['center']):12} {ctl['label'][:36]}")
        sys.stdout.flush()
        with open(os.path.join(out_dir, "checklist.json"), "w") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=1)
    print(f"# {len(rows)} controls -> {out_dir}/checklist.json")
    return rows


def cmd_scan():
    rows = controls()
    print(f"# {len(rows)} actionable controls (backend: wda)")
    for r in sorted(rows, key=lambda r: (r["center"][1], r["center"][0])):
        print(f"  {r['type']:14} {str(r['center']):12} {r['label'][:44]}")
    return 0


def cmd_shot(path, check):
    digest = shot(path)
    print(digest)
    if check and digest == shot(path.replace(".png", "-b.png")):
        print("FROZEN: two captures byte-identical; run `recover` if a real "
              "change just happened")
        return 2
    return 0


def cmd_wait(needle, secs):
    deadline = time.time() + secs
    while time.time() < deadline:
        if find(needle):
            print(f"found {needle!r}")
            return 0
        time.sleep(2)
    print(f"TIMEOUT waiting for {needle!r}")
    return 1


def cmd_logs(minutes):
    out = subprocess.run(
        ["xcrun", "simctl", "spawn", UDID_DEFAULT, "log", "show",
         "--last", f"{minutes or '3'}m", "--predicate", 'process == "DSHSpike"',
         "--style", "compact"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=180).stdout
    keep = [line for line in out.splitlines()
            if "dsh." in line or "error" in line.lower() or "fail" in line.lower()]
    print("\n".join(keep[-40:]))
    return 0


def cmd_recover():
    for cmd in (["shutdown"], ["boot"], ["bootstatus", "-b"]):
        subprocess.run(["xcrun", "simctl", *cmd, UDID_DEFAULT],
                       capture_output=True, timeout=200)
    time.sleep(6)
    print("recovered")
    return 0


def cmd_launch():
    subprocess.run(["xcrun", "simctl", "terminate", UDID_DEFAULT, BUNDLE],
                   capture_output=True)
    out = subprocess.run(["xcrun", "simctl", "launch", UDID_DEFAULT, BUNDLE],
                         capture_output=True, text=True, encoding="utf-8",
                         errors="replace")
    print((out.stdout or out.stderr).strip())
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["scan", "tap", "type", "shot", "wait",
                                    "sweep", "logs", "recover", "launch", "status"])
    ap.add_argument("arg", nargs="?", default="")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--secs", type=int, default=90)
    ap.add_argument("--hold", type=float, default=1.2)
    args = ap.parse_args()

    if args.cmd == "status":
        print("wda:", "up" if wda_up() else "down")
        return 0
    if args.cmd == "scan":
        return cmd_scan()
    if args.cmd == "tap":
        return tap(args.arg, args.hold)
    if args.cmd == "type":
        return type_text(args.arg, args.hold)
    if args.cmd == "shot":
        return cmd_shot(args.arg, args.check)
    if args.cmd == "wait":
        return cmd_wait(args.arg, args.secs)
    if args.cmd == "sweep":
        sweep(args.arg or "hosts/ios/artifacts/ui-sweep", args.hold)
        return 0
    if args.cmd == "logs":
        return cmd_logs(args.arg)
    if args.cmd == "recover":
        return cmd_recover()
    if args.cmd == "launch":
        return cmd_launch()
    return 0


if __name__ == "__main__":
    sys.exit(main())
