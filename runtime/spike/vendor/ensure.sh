#!/bin/sh
# Fetch + verify the vendored quickjs-ng engine sources. Idempotent: exits 0
# when the pinned sources are already present on disk.
#
# The vendor tree is UNTRACKED (gitignored) by design: the engine's real-world
# C cannot survive a tree-sitter editor-level parse gate, and compile truth
# belongs to the platform compilers anyway. The pin lives HERE — commit sha +
# tarball sha256 — so what lands on disk is always verbatim upstream.
#
# Run before any build that embeds the engine (desktop CLI, iOS, Android,
# HarmonyOS NAPI). Network is only needed on first fetch.
set -e
cd "$(dirname "$0")"

PIN=0.17.0
COMMIT=6d46d07d04041b40f4f49eaa7fdebe44c314c699
TARBALL_SHA256=a62cf1ff7d6d2f82b90a2d247a57e9eb56b81c03feb1f372a53923426e358cb0
DIR="quickjs-ng/$PIN"

FILES="dtoa.c libregexp.c libunicode.c quickjs.c \
cutils.h dtoa.h libregexp.h libregexp-opcode.h libunicode.h libunicode-table.h \
list.h quickjs.h quickjs-atom.h quickjs-opcode.h quickjs-c-atomics.h \
builtin-array-fromasync.h builtin-iterator-zip.h builtin-iterator-zip-keyed.h \
LICENSE"

have_all() {
    for f in $FILES; do [ -f "$DIR/$f" ] || return 1; done
}

if have_all; then
    echo "vendor: quickjs-ng $PIN present ($COMMIT)"
    exit 0
fi

mkdir -p "$DIR"
TMP=$(mktemp /tmp/dsh-qjs.XXXXXX.tar.gz)
curl -fL "https://github.com/quickjs-ng/quickjs/archive/$COMMIT.tar.gz" -o "$TMP"
echo "$TARBALL_SHA256  $TMP" | shasum -a 256 -c - >/dev/null
for f in $FILES; do
    tar xzf "$TMP" -C "$DIR" --strip-components=1 "quickjs-$COMMIT/$f"
done
rm -f "$TMP"

have_all || { echo "vendor: fetch incomplete — refusing to continue" >&2; exit 1; }
echo "vendor: quickjs-ng $PIN fetched and verified ($COMMIT)"
