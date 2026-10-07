#!/bin/sh
# parity-node-modules.sh — materialize the Node resolution layout for the
# parity reference leg and the raw upstream-suite vitest face (idempotent;
# lives INSIDE the untracked vendor tree, so a vendor re-fetch wipes it and
# this script rebuilds it).
#
# Node resolves package specifiers from the REAL path of the importing file
# (symlinks are realpath'd by default), so a node_modules beside the driver
# never satisfies imports made from inside vendor/dsh/*/. The layout that
# works is one on the real ancestor chain shared by every vendored package:
# runtime/dsh/vendor/node_modules/ — reachable from vendor/dsh/<pkg>/lib
# and vendor/npm/<pkg>/lib alike.
#
# One deliberate substitute: @deepseek-ai/dsh-session-persistence is served
# under quickjs by the errors-only linkage shim
# (upstream/shims/dsh-session-persistence.js — the real package is koffi-bound
# and not vendored); the same shim bytes become a Node package here, so the
# reference spine links exactly what the port spine links.
#
# --parity-only keeps the reference leg's resolution surface EXACTLY as the
# product links define it: the parity differential compares the vendored
# spine under plain Node against the quickjs port leg, so adding resolution
# targets to one side alone would manufacture divergences. run-upstream-parity.sh
# passes it; the raw vitest face and the sweep's node leg run without it and
# get every test face linked.
set -eu
SPIKE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$SPIKE_ROOT/vendor"
NM="$VENDOR/node_modules"
SCOPE="$NM/@deepseek-ai"
PARITY_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --parity-only) PARITY_ONLY=1 ;;
        *) echo "usage: parity-node-modules.sh [--parity-only]" >&2; exit 2 ;;
    esac
done

mkdir -p "$SCOPE"

# Every vendored dsh package, symlinked under its real npm name. The closure
# tree is ensure-dsh.sh's product; a tests-only materialization
# (ensure-dsh-tests.sh standalone) legitimately lacks it — the notice names
# the absent face instead of leaving a silent half-layout (#328).
if [ -d "$VENDOR/dsh" ]; then
    for dir in "$VENDOR"/dsh/*/; do
        name="$(node -e "console.log(require('${dir}package.json').name)")"
        link="$SCOPE/${name#@deepseek-ai/}"
        mkdir -p "$(dirname "$link")"
        ln -sfn "$dir" "$link"
    done
else
    echo "parity node_modules: vendor/dsh absent (tests-only materialization) — the closure face is not linked; run ensure-dsh.sh for the parity spine" >&2
fi

# The vendored npm dependencies (cordis and friends), same treatment. Each of
# these links CLAIMS its name at the scope level, so a face the tree does not
# carry must leave the name UNLINKED — a dangling claim would silently block
# the test-face loop below from ever linking a later pin of the same name
# (the #328 rot, one level up).
link_named() { # link_named <target-dir> <name>
    [ -d "$1" ] || { echo "parity node_modules: face absent, name left unlinked: $2 (target $1 missing)" >&2; return 0; }
    ln -sfn "$1" "$SCOPE/$2"
}
link_named "$VENDOR/npm/cordis@4.0.2" cordis
link_named "$VENDOR/npm/cosmokit@1.8.3" cosmokit
link_named "$VENDOR/npm/schemastery@3.18.2" schemastery
link_named "$VENDOR/npm/@deepseek-ai/cordis-plugin-loader@1.0.3" cordis-plugin-loader
link_named "$VENDOR/npm/@deepseek-ai/cordis-plugin-include@1.0.7" cordis-plugin-include
# Unscoped names land at the node_modules top level — same claim discipline.
link_named_top() { # link_named_top <target-dir> <name>
    [ -d "$1" ] || { echo "parity node_modules: face absent, name left unlinked: $2 (target $1 missing)" >&2; return 0; }
    ln -sfn "$1" "$NM/$2"
}
link_named_top "$VENDOR/npm/zod@4.4.3" zod
link_named_top "$VENDOR/npm/diff@9.0.0" diff

# The upstream test-support vehicles (same version as the closure; the
# full-suite run resolves them like any vendored package). Linked by their
# REAL package names below (the generic test-face loop): the bare specifiers
# the suites import are '@deepseek-ai/dsh-agent-loop-testkit' & co, so the
# short-named links this script used before 2026-10-03 (agent-loop-testkit,
# llm-replay, session-snapshot, loader-smoke) never satisfied them — and
# nothing ever resolved through the short names either. Stale ones are
# removed so a re-run cannot keep them alive.
rm -f "$SCOPE/agent-loop-testkit" "$SCOPE/llm-replay" "$SCOPE/session-snapshot" "$SCOPE/loader-smoke"

# The errors-only persistence linkage shim as a real (tiny) package.
SHIM="$NM/.parity-shim-session-persistence"
mkdir -p "$SHIM/lib"
printf '{"name":"@deepseek-ai/dsh-session-persistence","version":"0.1.6-alpha.2","type":"module","exports":{".":"./lib/index.js"}}' \
    > "$SHIM/package.json"
cp "$SPIKE_ROOT/upstream/shims/dsh-session-persistence.js" "$SHIM/lib/index.js"
ln -sfn "$SHIM" "$SCOPE/dsh-session-persistence"

# The upstream-suite raw vitest face (issue #321, 2026-10-03): the vendored
# specs resolve bare imports by walking their real ancestor chain into THIS
# node_modules, so every registry test face needs a link here under its REAL
# package.json name. The product-face links above win when a name is already
# taken (the closure face is what the parity leg proves). A name claimed by a
# SECOND test-face version cannot be decided generically — it is reported and
# left unlinked, and the per-package staging below owns the deliberate choice.
# Skipped wholesale under --parity-only (see the header).
if [ "$PARITY_ONLY" -eq 1 ]; then
    echo "parity node_modules: --parity-only — the test-face links and per-package staging are skipped (the raw vitest face and the sweep's node leg run without the flag)"
else
TEST_LINKED="$(mktemp)"
trap 'rm -f "$TEST_LINKED"' EXIT
# Deliberate top-level collisions, pre-seeded so the generic loop never
# picks a major by glob order: chokidar and readdirp are staged per-package
# below (settings-file/credentials-local pin chokidar ^4, skill-filesystem
# pins ^5; each major needs its own readdirp). picomatch is linked to 4.0.4
# right here — the included consumers declare ^4.0.4, while the 2.3.1 face
# serves the webworker-runtime Worker-VFS fixtures, which resolve it by
# explicit path and need no link.
printf '%s\n' chokidar readdirp > "$TEST_LINKED"
ln -sfn "$VENDOR/npm/picomatch@4.0.4" "$NM/picomatch"
for dir in "$VENDOR"/npm/*/ "$VENDOR"/npm/@*/*/; do
    [ -f "${dir}package.json" ] || continue
    name="$(node -e "console.log(require('${dir}package.json').name)")"
    link="$NM/$name"
    # A link whose target vanished (a re-pin moved the version dir, a row
    # was dropped) is STALE, not present — rule 5: present-but-stale must
    # refresh. The old skip kept every such name claimed by a dead target
    # until someone wiped the whole layout by hand (the #328 rot).
    if [ -L "$link" ] && [ ! -e "$link" ]; then
        rm -f "$link"
    fi
    # Already linked (product face above, or an explicit staged choice here).
    if [ -e "$link" ] || [ -L "$link" ]; then
        continue
    fi
    mkdir -p "$(dirname "$link")"
    if grep -qxF "$name" "$TEST_LINKED"; then
        echo "parity node_modules: COLLISION for $name — multiple vendored test-face versions; top level left UNLINKED (stage per-consumer deliberately)" >&2
        continue
    fi
    ln -s "$dir" "$link"
    printf '%s\n' "$name" >> "$TEST_LINKED"
done

# Per-package majors and platform faces, staged the way upstream's pnpm
# workspace resolves them: inside the consumer's (or dependency's) own
# node_modules. Nested SYMLINKS only — the vendored bytes stay verbatim.
stage_nested() { # <inside-dir> <link-name> <target-dir>
    inside="$1" sub="$2" target="$3"
    [ -d "$target" ] || { echo "parity node_modules: nested stage target MISSING: $target" >&2; exit 1; }
    mkdir -p "$inside"
    ln -sfn "$target" "$inside/$sub"
}
TESTS="$VENDOR/dsh-tests@dsh-v0.1.6-alpha.2"
[ -d "$TESTS" ] || { echo "parity node_modules: $TESTS not materialized — run vendor/ensure-dsh-tests.sh first" >&2; exit 1; }
# chokidar per-consumer majors + per-major readdirp (chokidar 4 → readdirp 4,
# chokidar 5 → readdirp 5). Both the vendored closure faces (whose lib the
# specs load through the chain) and the dsh-tests source packages pin their
# own major. hmr pins chokidar ^4 too, but its tier is excluded from this
# face — not staged.
stage_nested "$TESTS/packages/settings/settings-file/node_modules" chokidar "$VENDOR/npm/chokidar@4.0.3"
stage_nested "$TESTS/packages/credentials/credentials-local/node_modules" chokidar "$VENDOR/npm/chokidar@4.0.3"
stage_nested "$TESTS/packages/skill/skill-filesystem/node_modules" chokidar "$VENDOR/npm/chokidar@5.0.0"
stage_nested "$TESTS/packages/experimental/webworker-runtime/node_modules" chokidar "$VENDOR/npm/chokidar@5.0.0"
# The three seats whose CONSUMER lives in vendor/dsh/ exist only when
# ensure-dsh.sh ran; a tests-only materialization has no closure face to
# stage into — named, not silently skipped, and no dangling claim (#328).
if [ -d "$VENDOR/dsh/dsh-settings-file@0.1.6-alpha.2" ]; then
    stage_nested "$VENDOR/dsh/dsh-settings-file@0.1.6-alpha.2/node_modules" chokidar "$VENDOR/npm/chokidar@4.0.3"
else
    echo "parity node_modules: vendor/dsh/dsh-settings-file@0.1.6-alpha.2 absent — its chokidar seat is not staged" >&2
fi
if [ -d "$VENDOR/dsh/dsh-credentials-local@0.1.6-alpha.2" ]; then
    stage_nested "$VENDOR/dsh/dsh-credentials-local@0.1.6-alpha.2/node_modules" chokidar "$VENDOR/npm/chokidar@4.0.3"
else
    echo "parity node_modules: vendor/dsh/dsh-credentials-local@0.1.6-alpha.2 absent — its chokidar seat is not staged" >&2
fi
if [ -d "$VENDOR/dsh/skill-filesystem@0.1.6-alpha.2" ]; then
    stage_nested "$VENDOR/dsh/skill-filesystem@0.1.6-alpha.2/node_modules" chokidar "$VENDOR/npm/chokidar@5.0.0"
else
    echo "parity node_modules: vendor/dsh/skill-filesystem@0.1.6-alpha.2 absent — its chokidar seat is not staged" >&2
fi
stage_nested "$VENDOR/npm/chokidar@4.0.3/node_modules" readdirp "$VENDOR/npm/readdirp@4.1.2"
stage_nested "$VENDOR/npm/chokidar@5.0.0/node_modules" readdirp "$VENDOR/npm/readdirp@5.0.0"
# compression@1.8.1 (webserver middleware) froze negotiator ~0.6 while the
# closure carries negotiator 1.1.0 at top level — the old major nests inside
# compression's own dir; debug@2.6.9 brings ms@2.1.3 the same way.
stage_nested "$VENDOR/npm/compression@1.8.1/node_modules" negotiator "$VENDOR/npm/negotiator@0.6.4"
stage_nested "$VENDOR/npm/debug@2.6.9/node_modules" ms "$VENDOR/npm/ms@2.1.3"
# cross-spawn@7.0.6 (MCP stdio) froze path-key ^3 while execa's closure put
# path-key 4.0.0 at top level — the old major nests inside cross-spawn.
stage_nested "$VENDOR/npm/cross-spawn@7.0.6/node_modules" path-key "$VENDOR/npm/path-key@3.1.1"
# sharp: the @img platform binaries sharp resolves through its
# optionalDependencies (glibc linux, both arches the suite runs). Each
# binding's RUNPATH also expects an unversioned sharp-libvips-linux-<arch>
# sibling inside its own package dir — staged too, or the dlopen of
# libvips-cpp fails even with the binary resolvable.
stage_nested "$VENDOR/npm/sharp@0.35.3/node_modules/@img" sharp-linux-x64 "$VENDOR/npm/@img/sharp-linux-x64@0.35.3"
stage_nested "$VENDOR/npm/sharp@0.35.3/node_modules/@img" sharp-libvips-linux-x64 "$VENDOR/npm/@img/sharp-libvips-linux-x64@1.3.2"
stage_nested "$VENDOR/npm/sharp@0.35.3/node_modules/@img" sharp-linux-arm64 "$VENDOR/npm/@img/sharp-linux-arm64@0.35.3"
stage_nested "$VENDOR/npm/sharp@0.35.3/node_modules/@img" sharp-libvips-linux-arm64 "$VENDOR/npm/@img/sharp-libvips-linux-arm64@1.3.2"
# Each @img binding's DT_RPATH expects an UNVERSIONED sharp-libvips-linux-<arch>
# sibling at the @img level ($ORIGIN/../../sharp-libvips-linux-<arch>/lib);
# without it the dlopen of libvips-cpp fails even with the binary resolvable.
stage_nested "$VENDOR/npm/@img" sharp-libvips-linux-x64 "$VENDOR/npm/@img/sharp-libvips-linux-x64@1.3.2"
stage_nested "$VENDOR/npm/@img" sharp-libvips-linux-arm64 "$VENDOR/npm/@img/sharp-libvips-linux-arm64@1.3.2"
# node-addon-system: the prebuilt platform packages its flock/landlock-run
# faces require.resolve at call time (importing stays addon-free).
stage_nested "$VENDOR/npm/@deepseek-ai/node-addon-system@0.1.2/node_modules/@deepseek-ai" node-addon-system-linux-x64 "$VENDOR/npm/@deepseek-ai/node-addon-system-linux-x64@0.1.2"
stage_nested "$VENDOR/npm/@deepseek-ai/node-addon-system@0.1.2/node_modules/@deepseek-ai" node-addon-system-linux-arm64 "$VENDOR/npm/@deepseek-ai/node-addon-system-linux-arm64@0.1.2"
fi  # --parity-only guard around the test-face staging

# The driver itself lives at runtime/dsh/ci/ — OUTSIDE the vendor tree —
# so its own specifier resolution needs one more link on ITS ancestor chain.
ln -sfn vendor/node_modules "$SPIKE_ROOT/node_modules"

echo "parity node_modules layout ready: $NM (+ $SPIKE_ROOT/node_modules link)"
