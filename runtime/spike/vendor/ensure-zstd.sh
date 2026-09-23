#!/bin/sh
# ensure-zstd.sh — vendor the OFFICIAL zstd C library (BSD-3-Clause) at a
# pinned release, for in-process compilation into the shared C host. The
# same pin discipline as quickjs/wasm3/ish: untracked tree, sha256-verified
# tarball, the ensure script IS the provenance record (D6).
#
# Node 24 ships zstd natively in node:zlib; the vendored upstream spine
# (session-persistence-jsonl family) uses that face. Our runtime serves it
# from the compiled-in library through host intrinsics (dsh_spike_host's
# __zstdCompress/__zstdDecompress) + the node:zlib shim (upstream/shims).
set -e
cd "$(dirname "$0")"

VERSION=1.5.7
TARBALL_SHA256=37d7284556b20954e56e1ca85b80226768902e2edabd3b649e9e72c0c9012ee3
DIR="zstd/$VERSION"

# Vendored subset: the whole lib/ core (common+compress+decompress) minus
# the CLI/deprecated/legacy/dictBuilder extras. Single-threaded (no
# ZSTD_MULTITHREAD): the host is one serial thread by constitution (D2).
FILES="zstd.h zstd_errors.h
common/zstd_common.c common/debug.c common/entropy_common.c
common/error_private.c common/fse_decompress.c common/xxhash.c
common/pool.c common/threading.c
compress/fse_compress.c compress/hist.c compress/huf_compress.c
compress/zstd_compress.c
compress/zstd_compress_literals.c compress/zstd_compress_sequences.c
compress/zstd_compress_superblock.c
compress/zstd_double_fast.c compress/zstd_fast.c compress/zstd_lazy.c
compress/zstd_ldm.c compress/zstd_preSplit.c compress/zstd_opt.c
decompress/huf_decompress.c decompress/zstd_ddict.c
decompress/zstd_decompress.c decompress/zstd_decompress_block.c"

HEADERS="common/xxhash.h common/zstd_internal.h common/zstd_deps.h common/mem.h common/pool.h common/threading.h common/zstd_trace.h
common/compiler.h common/debug.h common/error_private.h common/fse.h
common/huf.h common/bits.h common/bitstream.h common/allocations.h
common/cpu.h common/portability_macros.h
compress/zstd_compress_internal.h compress/zstd_compress_literals.h
compress/zstd_compress_sequences.h compress/zstd_compress_superblock.h
compress/zstd_ldm.h compress/zstd_preSplit.h compress/zstdmt_compress.h
compress/hist.h
compress/clevels.h compress/zstd_cwksp.h compress/zstd_double_fast.h
compress/zstd_fast.h compress/zstd_lazy.h compress/zstd_ldm_geartab.h
compress/zstd_opt.h
decompress/zstd_decompress_block.h decompress/zstd_decompress_internal.h
decompress/zstd_ddict.h"

if [ -f "$DIR/.vendor-pin" ] && [ "$(cat "$DIR/.vendor-pin")" = "$TARBALL_SHA256" ]; then
    echo "vendor: zstd $VERSION present (pin-stamped)"
    exit 0
fi

TMP=$(mktemp /tmp/dsh-zstd.XXXXXX)
curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 20 \
    "https://github.com/facebook/zstd/archive/refs/tags/v$VERSION.tar.gz" -o "$TMP"
echo "$TARBALL_SHA256  $TMP" | shasum -a 256 -c - >/dev/null

rm -rf "$DIR"
mkdir -p "$DIR"
for f in $FILES $HEADERS; do
    # --strip-components=2: zstd-<ver>/lib/<path> -> <path>
    tar xzf "$TMP" -C "$DIR" --strip-components=2 "zstd-$VERSION/lib/$f" || {
        echo "vendor: zstd file missing in tarball: $f" >&2
        rm -f "$TMP"; exit 1; }
done
# hist.h lives in lib/compress in the source tree only from some versions
tar xzf "$TMP" -C "$DIR" --strip-components=2 "zstd-$VERSION/lib/compress/hist.h" 2>/dev/null || true
# zstd_deps/common includes reference pool.h/threading.h only for MT builds (off)
rm -f "$TMP"
echo "$TARBALL_SHA256" > "$DIR/.vendor-pin"
echo "vendor: zstd $VERSION fetched and verified (BSD-3-Clause, single-thread)"
