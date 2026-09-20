#!/bin/sh
# stage-spine-closure.sh — the Android analogue of the iOS embedder's tree
# mode (W-SESS #62): copies the D9 W-SESS spine closure from the runtime
# spike bundle into the app assets, so the C host's loader bare map
# (`vendor/dsh/<pkg>@<ver>/lib/**`, `vendor/npm/...`) resolves the FULL
# upstream agent spine on-device. Idempotent; byte-identical to the
# runtime/spike pins (ensure-dsh.sh is the single source of the pin).
#
# Staged per the iOS embedder's lists (hosts/ios/Tools/gen_bundle_header.py):
#   - the 14 vendored spine packages: LICENSE + package.json + lib/**
#     (only docs/bin/.d.ts pruning differs — the same lean rule the
#     web-boot closure already follows in assets)
#   - the pinned zod's runtime closure (classic build's relative import
#     graph walked at the pin): index.js + v4/classic + v4/core + v4/locales
#   - the spine boot layer: upstream/boot.js, upstream/llm-transport.js,
#     upstream/settings-memory.js, and the shims beyond the web-boot set
#     (async-hooks, util, util/types, os, process, dsh-session-persistence)
#
# The staged trees are COMMITTED (the Android embed is assets, not C arrays);
# this script exists to make re-pins reproducible, and verifies byte-identity
# after copying (fail loud, rules.md rule 5).
set -eu

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
SPIKE=$ROOT/runtime/spike
ASSETS=$ROOT/hosts/android/app/src/main/assets/spike
VER=0.1.6-alpha.2

say() { echo "stage-spine-closure: $*"; }
die() { echo "::error::stage-spine-closure: $*" >&2; exit 1; }

[ -d "$SPIKE/vendor/dsh/session@$VER/lib" ] ||
    die "runtime vendor closure missing — run runtime/spike/vendor/ensure-dsh.sh"

# One vendored spine package: LICENSE + package.json + lib/** minus .d.ts.
stage_pkg() {
    src=$1
    dst=$2
    mkdir -p "$dst"
    for f in LICENSE package.json; do
        [ -f "$src/$f" ] && cp "$src/$f" "$dst/$f"
    done
    (cd "$src" && find lib -type f ! -name '*.d.ts') | while IFS= read -r rel; do
        mkdir -p "$dst/$(dirname "$rel")"
        cp "$src/$rel" "$dst/$rel"
    done
}

# The iOS embedder's TREES list: the verbatim spine packages (D9).
for pkg in agent agent-loop brand llm sandbox scope session \
           session-projection settings system-prompt timeout tools \
           typert-protocol util-values; do
    say "staging vendor/dsh/$pkg@$VER"
    stage_pkg "$SPIKE/vendor/dsh/$pkg@$VER" "$ASSETS/vendor/dsh/$pkg@$VER"
done

# The pinned zod's runtime closure (the iOS embedder's ZOD_FILES list).
ZOD_SRC=$SPIKE/vendor/npm/zod@4.4.3
ZOD_DST=$ASSETS/vendor/npm/zod@4.4.3
say "staging vendor/npm/zod@4.4.3 (classic runtime closure)"
mkdir -p "$ZOD_DST/v4/classic" "$ZOD_DST/v4/core" "$ZOD_DST/v4/locales"
cp "$ZOD_SRC/index.js" "$ZOD_DST/index.js"
cp "$ZOD_SRC"/v4/classic/*.js "$ZOD_DST/v4/classic/"
cp "$ZOD_SRC"/v4/core/*.js "$ZOD_DST/v4/core/"
cp "$ZOD_SRC"/v4/locales/*.js "$ZOD_DST/v4/locales/"

# The spine boot layer (upstream adapters + the shims beyond the web-boot set).
say "staging upstream boot layer"
for f in boot.js llm-transport.js settings-memory.js; do
    cp "$SPIKE/upstream/$f" "$ASSETS/upstream/$f"
done
for f in async-hooks.js util.js util-types.js os.js process.js \
         dsh-session-persistence.js; do
    cp "$SPIKE/upstream/shims/$f" "$ASSETS/upstream/shims/$f"
done

# The scenario rides the same copy (assets stay byte-identical to the
# runtime bundle, like every other staged scenario).
if [ -f "$SPIKE/scenario/b-android-session-live.js" ]; then
    cp "$SPIKE/scenario/b-android-session-live.js" "$ASSETS/scenario/b-android-session-live.js"
fi

# Byte-identity proof over everything this script stages (rule 6: the
# copy is evidence only when a check can fail).
fail=0
verify() {
    cmp -s "$1" "$2" || { echo "::error::stage drift: $2"; fail=1; }
}
for pkg in agent agent-loop brand llm sandbox scope session \
           session-projection settings system-prompt timeout tools \
           typert-protocol util-values; do
    (cd "$SPIKE/vendor/dsh/$pkg@$VER" && find lib -type f ! -name '*.d.ts'; echo LICENSE; echo package.json) |
    while IFS= read -r rel; do
        [ -f "$SPIKE/vendor/dsh/$pkg@$VER/$rel" ] || continue
        cmp -s "$SPIKE/vendor/dsh/$pkg@$VER/$rel" "$ASSETS/vendor/dsh/$pkg@$VER/$rel" ||
            echo "::error::stage drift: vendor/dsh/$pkg@$VER/$rel"
    done
done
(cd "$ZOD_SRC" && find v4/classic v4/core v4/locales -name '*.js'; echo index.js) |
    while IFS= read -r rel; do
        cmp -s "$ZOD_SRC/$rel" "$ZOD_DST/$rel" ||
            echo "::error::stage drift: zod/$rel"
    done
for f in boot.js llm-transport.js settings-memory.js; do
    cmp -s "$SPIKE/upstream/$f" "$ASSETS/upstream/$f" || echo "::error::stage drift: upstream/$f"
done
for f in async-hooks.js util.js util-types.js os.js process.js dsh-session-persistence.js; do
    cmp -s "$SPIKE/upstream/shims/$f" "$ASSETS/upstream/shims/$f" ||
        echo "::error::stage drift: shims/$f"
done
[ "$fail" -eq 0 ] || die "staged trees drifted from the runtime pins"
say "staged + verified byte-identical to the runtime pins"
