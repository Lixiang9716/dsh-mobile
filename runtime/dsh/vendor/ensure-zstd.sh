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

# fetch_retry <url> <out> — bounded retries around a TRANSIENT download
# failure, window sized for CI's cold materialization (see ensure.sh for the
# measured 504 that cost a CI job): 5 outer attempts, inner curl --retry 2,
# waits 5/10/20/40. This script was the one download site the 2026-09-21
# retry fix missed — it rode bare curl flags alone.
fetch_retry() {
  _url="$1"; _out="$2"; _n=0; _wait=5
  while [ "$_n" -lt 5 ]; do
    _n=$((_n + 1))
    if curl -fsSL --retry 2 --retry-delay 3 --connect-timeout 20 --max-time 300 \
         "$_url" -o "$_out"; then
      return 0
    fi
    echo "vendor: download attempt $_n/5 failed: $_url" >&2
    if [ "$_n" -lt 5 ]; then sleep "$_wait"; _wait=$((_wait * 2)); fi
  done
  echo "vendor: download FAILED after 5 attempts: $_url" >&2
  return 1
}

# fetch_verified <label> <url> <out> <sha256> — download + integrity as ONE
# bounded unit: a 200 with a truncated/corrupt body passes curl's exit, so a
# digest mismatch REFETCHES; three mismatches fail loud naming label, source,
# and expected digest (a bare shasum death names neither — #289 feedback).
fetch_verified() {
  _label="$1"; _url="$2"; _out="$3"; _sha="$4"; _d=0
  while :; do
    fetch_retry "$_url" "$_out" || {
      echo "vendor: $_label — download FAILED after retries from $_url" >&2
      exit 1
    }
    if echo "$_sha  $_out" | shasum -a 256 -c - >/dev/null 2>&1; then
      return 0
    fi
    _d=$((_d + 1))
    if [ "$_d" -ge 3 ]; then
      echo "vendor: $_label — sha256 MISMATCH after 3 fetches from $_url (expected $_sha) — refusing to continue" >&2
      rm -f "$_out"
      exit 1
    fi
    echo "vendor: $_label — digest mismatch (fetch $_d) — refetching from $_url" >&2
    rm -f "$_out"
  done
}

TMP=$(mktemp /tmp/dsh-zstd.XXXXXX)
fetch_verified "zstd $VERSION" \
    "https://github.com/facebook/zstd/archive/refs/tags/v$VERSION.tar.gz" \
    "$TMP" "$TARBALL_SHA256"

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
