#!/bin/sh
# add-package.sh — the mechanical half of introducing a vendored package.
# The JUDGMENT half (which embed lists the package joins, preset roster,
# boot wiring, commit ordering) lives in the vendor-package Agent Skill
# (.agents/skills/vendor-package/SKILL.md); this script does what needs no
# judgment and prints what still needs pasting.
#
#   fetch <name>@<version>   download the registry tarball, sha256 it, place
#                            it in the TRACKED MIRROR, print the pin row
#                            (paste into NPM_PACKAGES in ensure-dsh.sh)
#   rows <name>@<version>    from the materialized tree, print the embed-list
#                            rows per host (iOS TREES tuple, harmony
#                            SPINE_PKG_DSH / CLOSURE + BUNDLE_FILES, preset
#                            roster template) — paste what the skill says
#   regen                    re-stage every host's committed closure from the
#                            canonical trees (= build/build.sh sync, minus
#                            compiles)
#   verify                   the closure gate subset (closures + bundle-files)
#
# The mirror is TRACKED (vendor/dsh-tarballs/, D6's pin record): a package is
# only landed once its tarball is committed there AND its row is pinned in
# ensure-dsh.sh — CI materializes from the mirror first, network second.
set -eu
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
VENDOR=runtime/spike/vendor
MIRROR=$VENDOR/dsh-tarballs
REGISTRY=${DSH_NPM_REGISTRY:-https://registry.npmjs.org}

say() { echo "add-package: $*"; }
die() { echo "::error::add-package: $*" >&2; exit 1; }
usage() {
    echo "usage: add-package.sh fetch <name>@<version>" >&2
    echo "       add-package.sh rows  <name>@<version>" >&2
    echo "       add-package.sh regen" >&2
    echo "       add-package.sh verify" >&2
    exit 2
}

# `@scope/name@1.2.3` → SCOPE=@scope PKG=name VER=1.2.3 FULL=@scope/name
# FLAT=scope-name-1.2.3 (the tracked-mirror filename layout). Unscoped names
# get an empty SCOPE.
parse() {
    case $1 in
        @*/*@*) SCOPE=${1%%/*}; REST=${1#"$SCOPE/"} ;;
        *@*)    SCOPE=;         REST=$1 ;;
        *) die "expected <name>@<version>, got '$1'" ;;
    esac
    case $REST in
        *@*) PKG=${REST%@*}; VER=${REST#*@} ;;
        *) die "expected <name>@<version>, got '$1'" ;;
    esac
    [ -n "$PKG" ] && [ -n "$VER" ] || die "expected <name>@<version>, got '$1'"
    FULL="${SCOPE:+$SCOPE/}$PKG"
    FLAT=$(printf '%s' "$FULL@$VER" | sed 's/^@//; s|/|-|g; s/@/-/')
}

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

fetch() {
    parse "$1"
    mkdir -p "$MIRROR"
    if [ -f "$MIRROR/$FLAT.tgz" ]; then
        say "mirror already carries $FLAT.tgz — reusing it"
    else
        say "fetching $FULL@$VER from $REGISTRY"
        # The registry serves scoped tarballs at the literal @scope path.
        curl --fail --location --silent --show-error \
            "$REGISTRY/$FULL/-/$PKG-$VER.tgz" -o "$MIRROR/$FLAT.tgz" \
            || die "registry fetch failed — place the tarball at $MIRROR/$FLAT.tgz by hand and rerun"
    fi
    SHA=$(sha256_of "$MIRROR/$FLAT.tgz")
    say "sha256 $SHA"
    say "committed tarball: $MIRROR/$FLAT.tgz (git add it)"
    say "pin row for NPM_PACKAGES (runtime/spike/vendor/ensure-dsh.sh):"
    printf '  %s@%s|%s/-/%s-%s.tgz|%s\n' "$FULL" "$VER" "$FULL" "$PKG" "$VER" "$SHA"
    say "then materialize + stamp-verify: runtime/spike/vendor/ensure-dsh.sh"
}

# Which face did ensure materialize? DSH_PACKAGES pins extract to
# vendor/dsh/<name>@<ver> (the mirror's workspace trees); NPM_PACKAGES pins
# extract to vendor/npm/<name>@<ver> (registry tarballs). The FACE decides
# which embed lists take rows and what advice is true.
detect_face() {
    DSH_DIR="$VENDOR/dsh/$PKG@$VER"
    NPM_DIR="$VENDOR/npm/$FULL@$VER"
    if [ -d "$DSH_DIR" ]; then FACE=dsh
    elif [ -d "$NPM_DIR" ]; then FACE=npm
    else
        die "no materialized tree — expected $DSH_DIR (DSH_PACKAGES pin) or $NPM_DIR (NPM_PACKAGES pin); pin the row + run ensure-dsh.sh first"
    fi
    TREE_DIR=$([ "$FACE" = dsh ] && printf '%s' "$DSH_DIR" || printf '%s' "$NPM_DIR")
    say "face=$FACE — tree: $TREE_DIR ($(find "$TREE_DIR" -type f | wc -l | tr -d ' ') files)"
}

rows() {
    parse "$1"
    detect_face
    SHORT=
    case $FULL in @deepseek-ai/dsh-*) SHORT=$PKG ;; esac

    say ""
    say "=== iOS — hosts/ios/Tools/gen_bundle_header.py, TREES ==="
    if [ "$FACE" = dsh ]; then
        say "add '$PKG' to the names list of the vendor/dsh TREES comprehension:"
        printf '    ..."%s", ...\n' "$PKG"
    elif [ -n "$SHORT" ]; then
        # vendor/dsh dir names follow the monorepo WORKSPACE name (tool-bash,
        # not dsh-tool-bash) — the shape every staged preset package uses.
        say "preset-riding → staged rel is vendor/dsh (the marker seeder walks it), bytes npm:"
        printf '    ("vendor/dsh/%s@%s",\n     SPIKE / "vendor" / "npm" / "%s" / "%s@%s"),\n' \
            "${SHORT#dsh-}" "$VER" "$SCOPE" "$PKG" "$VER"
        say "or imported by boot.js only (no preset row) → stage in place:"
        printf '    ("vendor/npm/%s@%s",\n     SPIKE / "vendor" / "npm" / "%s" / "%s@%s"),\n' \
            "$FULL" "$VER" "$SCOPE" "$PKG" "$VER"
    else
        printf '    ("vendor/npm/%s@%s",\n     SPIKE / "vendor" / "npm" / "%s@%s"),\n' \
            "$FULL" "$VER" "$FULL" "$VER"
    fi

    say ""
    say "=== harmony — hosts/harmony/ci/vendor-official.sh + Index.ets BUNDLE_FILES ==="
    if [ "$FACE" = dsh ]; then
        say "add '$PKG' to SPINE_PKG_DSH (its find lib loop stages the vendor/dsh tree); BUNDLE_FILES rows:"
        (cd "$DSH_DIR" && find lib -type f ! -name '*.d.ts' 2>/dev/null) | LC_ALL=C sort | while IFS= read -r f; do
            printf "  'vendor/dsh/%s@%s/%s',\n" "$PKG" "$VER" "$f"
        done
        printf "  'vendor/dsh/%s@%s/package.json',\n" "$PKG" "$VER"
    elif [ -n "$SHORT" ]; then
        say "a vendor-official copy is same-rel, so staging npm bytes at a vendor/dsh rel needs a"
        say "rel→src mapping added there (see task T-0048) — then BUNDLE_FILES rows at the rel:"
        (cd "$NPM_DIR" && find lib -type f ! -name '*.d.ts' 2>/dev/null) | LC_ALL=C sort | while IFS= read -r f; do
            printf "  'vendor/dsh/%s@%s/%s',\n" "${SHORT#dsh-}" "$VER" "$f"
        done
        printf "  'vendor/dsh/%s@%s/package.json',\n" "${SHORT#dsh-}" "$VER"
    else
        say "explicit CLOSURE rows — keep only the lib faces the loader imports:"
        (cd "$NPM_DIR" && find . -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.json' \)) \
            | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do
            printf '  vendor/npm/%s@%s/%s\n' "$FULL" "$VER" "$f"
        done
        say "BUNDLE_FILES rows: exactly the staged paths, single-quoted, in Index.ets"
    fi

    say ""
    say "=== preset (runtime/spike/presets-mobile/mobile/agent.cordis.yml) — JUDGMENT ==="
    if [ -n "$SHORT" ]; then
        say "a model-facing tool/plugin takes a roster row (preset health hard-fails on unresolvable rows):"
        printf '  - id: %s\n    name: '"'"'%s'"'"'\n' "${SHORT#dsh-}" "$FULL"
    else
        say "library packages take NO roster row (nothing model-facing to mount)"
    fi
}

regen() {
    say "ios: regenerate the embedded bundle (gen.sh additionally regens the xcode project)"
    python3 hosts/ios/Tools/gen_bundle_header.py
    say "harmony: stage the rawfile closure (no network, no officialweb)"
    hosts/harmony/ci/vendor-official.sh --closure-only
    say "android: stage the spine closure into assets (wholesale stager)"
    hosts/android/ci/stage-spine-closure.sh
    say ""
    say "commit BOTH sides before pushing — the closures gate diffs worktree-vs-index"
    say "and restores, so regenerated bundles must be committed to pass (the runtime-"
    say "closure commit and the regenerated-bundle commit are two commits by design)"
}

verify() {
    ~/.local/bin/gov run --gate closures bundle-files
    say "slow but decisive before a push: ~/.local/bin/gov run --gate vendoring-repro"
}

case ${1:-} in
    fetch)  shift; [ $# -eq 1 ] || usage; fetch "$1" ;;
    rows)   shift; [ $# -eq 1 ] || usage; rows "$1" ;;
    regen)  regen ;;
    verify) verify ;;
    *)      usage ;;
esac
