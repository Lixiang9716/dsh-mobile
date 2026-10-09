#!/usr/bin/env python3
"""Regenerate runtime/dsh/scenario/agent-presets-probe-seed.js.

The presets seed the CLI probe (and any scenario that mounts the REAL
AgentPresets service) delivers over the bus: the vendored presets tree bytes
plus one node_modules resolution marker per vendored dsh package, plus the
MOBILE preset (the deployment default, upstream/boot.js AGENT_PRESETS_DEFAULT)
synthesized from OUR outboard source doc at the same presets/mobile/ rel the
device stagers stage it (vendor-official.sh, gen_bundle_resources.py — the
vendored presets package itself stays pristine upstream, D6). The device
drives (iOS WebBootRuntimeDrive.agentPresetsSeedDelivery, and the staged
Android/Harmony equivalents) synthesize the SAME rule from their
staged trees — this script is the reproducible CLI twin.

Marker rule (agent-presets health resolution walks
  <preset-pkg>/node_modules/@deepseek-ai/<name>/package.json):
  {"name": "<pkg name>", "version": "<pkg version>",
   "_spike": "resolution marker (the bare map vendors this package)"}
A preset row naming a package WITHOUT a marker stays honestly `broken` —
markers are generated from the vendored closure only, never speculatively.

usage: gen-presets-seed.py   (writes the .js file; run from anywhere)
"""

import base64
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SPIKE = REPO / "runtime" / "dsh"
VENDOR = SPIKE / "vendor" / "dsh"
PRESETS_PKG = "agent-presets"
OUT = SPIKE / "scenario" / "agent-presets-probe-seed.js"
VFS_BASE = f"/vendor/dsh/{PRESETS_PKG}@"
MARKER_SPIKE = "resolution marker (the bare map vendors this package)"
# The MOBILE preset: OUR outboard source doc (the vendored presets package
# carries only the four upstream-shipped presets), synthesized into the seed
# at the same presets/mobile/ rel the device stagers copy it to. The file set
# is EXACTLY what the stagers stage — vendor-official.sh and
# gen_bundle_resources.py name these two files. A new source file must join
# every stager and this list in the same change: an unlisted file would make
# the CLI roster diverge from the devices' (rule 5 — fail loud, never a
# silent half-stage).
MOBILE_PRESET = SPIKE / "presets-mobile" / "mobile"
MOBILE_FILES = ("preset.yml", "agent.cordis.yml")


def collect_files() -> dict[str, str]:
    """The seed's {vfs_path: base64} map: presets tree + the mobile preset +
    resolution markers."""
    pkg_dirs = sorted(
        (d for d in VENDOR.iterdir() if d.is_dir() and "@0." in d.name),
        key=lambda d: d.name,
    )
    if not pkg_dirs:
        print(f"gen-presets-seed: no vendored packages under {VENDOR}", file=sys.stderr)
        sys.exit(1)
    files: dict[str, str] = {}
    files.update(presets_tree())
    files.update(mobile_tree())
    files.update(marker_entries(pkg_dirs))
    return files


def presets_tree() -> dict[str, str]:
    presets_root = VENDOR / f"{PRESETS_PKG}@0.1.6-alpha.2" / "presets"
    if not presets_root.is_dir():
        print(f"gen-presets-seed: missing {presets_root}", file=sys.stderr)
        sys.exit(1)
    out: dict[str, str] = {}
    for path in sorted(presets_root.rglob("*")):
        if path.is_file():
            # VFS paths are POSIX forever: on Windows relative_to yields
            # backslashes, and a raw interpolation would mint keys the
            # vendored discovery reads as single file names.
            rel = path.relative_to(presets_root).as_posix()
            vfs = f"{VFS_BASE}0.1.6-alpha.2/presets/{rel}"
            out[vfs] = base64.b64encode(path.read_bytes()).decode()
    return out


def mobile_tree() -> dict[str, str]:
    """The MOBILE preset's rows: our outboard composition doc + roster
    metadata, base64 under the presets/mobile/ rel — byte-identical to what
    the device stagers stage and the device seeders enumerate. Fail loud when
    the source dir carries anything the stagers do not stage (see
    MOBILE_FILES) — a silently divergent roster is the defect this guard
    exists for."""
    if not MOBILE_PRESET.is_dir():
        print(f"gen-presets-seed: missing {MOBILE_PRESET}", file=sys.stderr)
        sys.exit(1)
    present = sorted(p.name for p in MOBILE_PRESET.iterdir())
    unexpected = [n for n in present if n not in MOBILE_FILES]
    if unexpected:
        print(
            f"gen-presets-seed: {MOBILE_PRESET} carries files the device "
            f"stagers do not stage: {unexpected} — extend vendor-official.sh, "
            f"gen_bundle_resources.py and MOBILE_FILES together",
            file=sys.stderr,
        )
        sys.exit(1)
    out: dict[str, str] = {}
    for name in MOBILE_FILES:
        path = MOBILE_PRESET / name
        if not path.is_file():
            print(f"gen-presets-seed: missing {path}", file=sys.stderr)
            sys.exit(1)
        vfs = f"{VFS_BASE}0.1.6-alpha.2/presets/mobile/{name}"
        out[vfs] = base64.b64encode(path.read_bytes()).decode()
    return out


def marker_entries(pkg_dirs) -> dict[str, str]:
    """One resolution marker per vendored package (name+version from its own
    package.json — never assumed)."""
    out: dict[str, str] = {}
    for d in pkg_dirs:
        manifest = json.loads((d / "package.json").read_text(encoding='utf-8'))
        marker = {
            "name": manifest["name"], "version": manifest["version"],
            "_spike": MARKER_SPIKE,
        }
        vfs = f"{VFS_BASE}0.1.6-alpha.2/node_modules/{manifest['name']}/package.json"
        out[vfs] = base64.b64encode(
            json.dumps(marker, ensure_ascii=False).encode()
        ).decode()
    return out


def main() -> int:
    files = collect_files()
    markers = sum(1 for k in files if "/node_modules/" in k)

    # 3. Emit the module: a default-exported {vfsPath: {bytes, mtimeMs}} map.
    lines = [
        "// GENERATED by runtime/dsh/ci/gen-presets-seed.py — presets tree",
        "// (bytes, incl. the mobile preset synthesized from our outboard",
        "// presets-mobile/mobile source) + node_modules resolution markers,",
        "// one per vendored dsh package. Regenerate after every ensure-dsh.sh",
        "// re-pin; the device drives synthesize the same rule from their",
        "// staged trees.",
        "const files = {",
    ]
    for vfs in sorted(files):
        payload = ",".join(str(b) for b in base64.b64decode(files[vfs]))
        lines.append(f'  "{vfs}": {{ bytes: new Uint8Array([{payload}]), mtimeMs: 0 }},')
    lines += ["};", "export default files;"]
    OUT.write_text("\n".join(lines) + "\n", encoding='utf-8')
    print(f"gen-presets-seed: {len(files)} files ({markers} markers) -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
