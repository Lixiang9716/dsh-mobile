#!/usr/bin/env python3
"""Stage the vendored official Web Client into the built app bundle.

The harness (Debug) drives the E2E legs, and its runners stage the official
dist + client bundles into the app CONTAINER (Documents/official-web,
Documents/web-plugins) before launch — test/e2e/run-ios-b1.sh is the
reference. A user-facing build has no runner: a plain launch must reach the
official DSH Web UI with nothing staged from outside. So the release build
EMBEDS the same two trees as app bundle resources:

    DSHSpike.app/official-web/dist/**                    ← the official dist
    DSHSpike.app/official-web/plugins/npm/@deepseek-ai/** ← the client bundles

(the same `official-web/{dist,plugins}` layout hosts/harmony's rawfile
carries, so both hosts name the tree identically).

Invoked from the `StageOfficialWeb` Xcode build phase, which passes the
configuration and the destination:

    stage_official_web.py <CONFIGURATION> <RESOURCES_DIR>

Debug is a no-op (the harness stages Documents itself, and its evidence must
keep running from exactly the tree it stages). Release copies and then
re-reads every byte to prove the copy is identical to the source — a silent
short copy would ship a broken client, so it fails loud instead (rules.md
rule 5). Missing source trees are fatal in Release and named explicitly.

usage: stage_official_web.py Release \
           /path/to/DerivedData/Build/Products/Release-iphonesimulator/DSHSpike.app
"""

import hashlib
import shutil
import sys
from pathlib import Path

HOSTS_IOS = Path(__file__).resolve().parents[1]
REPO = HOSTS_IOS.parents[1]
OFFICIAL = REPO / "presentation" / "official-web"
DIST = OFFICIAL / "dist"
CLIENT_NPM = OFFICIAL / "client-bundles" / "npm"
# The pinned vendored tarball wins for the bootstrap package (D6 pin record;
# the same precedence test/e2e/run-ios-b1.sh and the Android staging apply).
VENDORED_BOOTSTRAP = (
    REPO / "runtime" / "spike" / "vendor" / "npm"
    / "@deepseek-ai" / "dsh-client-modules@0.1.6-alpha.2"
)
SCOPE = "@deepseek-ai"


def die(message: str) -> None:
    print(f"stage_official_web: FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def copy_tree(src: Path, dst: Path) -> int:
    """Copy `src` under `dst` verbatim, then re-read and hash both sides."""
    files = sorted(p for p in src.rglob("*") if p.is_file())
    if not files:
        die(f"{src} is empty (run test/e2e/ensure-official-dist.sh and "
            f"test/e2e/ensure-client-bundles.sh)")
    for path in files:
        target = dst / path.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        if hashlib.sha256(path.read_bytes()).digest() != \
                hashlib.sha256(target.read_bytes()).digest():
            die(f"copy drift: {target} != {path}")
    return len(files)


def main() -> int:
    if len(sys.argv) != 3:
        die("usage: stage_official_web.py <CONFIGURATION> <RESOURCES_DIR>")
    configuration, resources = sys.argv[1], Path(sys.argv[2])
    if configuration != "Release":
        print(f"stage_official_web: {configuration} — the harness stages "
              f"Documents itself, no bundle resources embedded")
        return 0
    for src in (DIST, CLIENT_NPM, VENDORED_BOOTSTRAP):
        if not src.is_dir():
            die(f"missing source tree {src} — run test/e2e/"
                f"ensure-official-dist.sh + ensure-client-bundles.sh + "
                f"runtime/spike/vendor/ensure-dsh.sh before the release build")

    root = resources / "official-web"
    if root.exists():
        shutil.rmtree(root)
    dist_files = copy_tree(DIST, root / "dist")
    plugins = root / "plugins" / "npm" / SCOPE
    plugin_files = copy_tree(CLIENT_NPM / SCOPE, plugins)
    # The pinned bootstrap package is copied LAST: the same path wins, which
    # is the declared intent (the pin beats the workspace build — the two
    # lib/client.js files are byte-identical at the pin per PROVENANCE).
    shutil.rmtree(plugins / VENDORED_BOOTSTRAP.name, ignore_errors=True)
    bootstrap_files = copy_tree(VENDORED_BOOTSTRAP, plugins / VENDORED_BOOTSTRAP.name)

    print(f"stage_official_web: embedded {dist_files} dist file(s), "
          f"{plugin_files} client-bundle file(s), "
          f"{bootstrap_files} pinned-bootstrap file(s) into {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
