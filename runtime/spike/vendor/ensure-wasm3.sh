#!/bin/sh
# Fetch + verify the vendored wasm3 interpreter sources. Idempotent: exits 0
# when the pinned sources are already present on disk.
#
# Same discipline as ensure.sh (quickjs-ng): the vendor tree is UNTRACKED, the
# pin lives HERE (tag + tarball sha256), what lands on disk is verbatim
# upstream, and only the files this repository actually BUILDS are extracted —
# the file list below is therefore also the record of what is vendored.
#
# Why a second engine: the WebAssembly path (contract v1.2.0 `wasmRun`) needs an
# in-process interpreter. iOS forbids JIT and this host refuses subprocesses
# (D2), so the module is interpreted inside the app's own process. wasm3 is a
# small MIT interpreter that builds from plain C with the same toolchain the
# other vendored C already uses; the module reaches the host through
# host-linked imports (dsh.emit), which is the seam the gateway bridges.
#
# Still staged OUT of this closure: the WASI backends (m3_api_wasi.c needs
# uvwasi, m3_api_meta_wasi.c) and m3_api_libc.c — the app's boundary is our own
# imported functions, not WASI's descriptor table.
#
# Run before any build that embeds the interpreter (iOS today). Network is only
# needed on first fetch.
set -e
cd "$(dirname "$0")"

PIN=0.9.0
TARBALL_SHA256=cab79ce74bcac25bbf80b5ebe14af9795b9bac30b05ee8f620a3bc8002f3b8e6
URL="https://github.com/wasm3/wasm3/archive/refs/tags/v$PIN.tar.gz"

# The interpreter core + every header it includes.
FILES="source/m3_core.c source/m3_env.c source/m3_parse.c source/m3_compile.c \
source/m3_code.c source/m3_module.c source/m3_function.c source/m3_bind.c \
source/m3_info.c source/m3_exec.c source/m3_validate.c \
source/wasm3.h source/wasm3_defs.h source/m3_config.h \
source/m3_config_platforms.h source/m3_core.h source/m3_env.h \
source/m3_exception.h source/m3_exec.h source/m3_exec_defs.h \
source/m3_function.h source/m3_info.h source/m3_math_utils.h \
source/m3_compile.h source/m3_code.h source/m3_bind.h source/m3_validate.h"

DIR="wasm3/$PIN"

fetch_retry() {
  _url="$1"; _out="$2"; _n=0
  while [ "$_n" -lt 3 ]; do
    _n=$((_n + 1))
    if curl -fL --retry 3 --retry-delay 5 --connect-timeout 20 \
         "$_url" -o "$_out" 2>/dev/null; then
      return 0
    fi
    echo "vendor: download attempt $_n/3 failed: $_url" >&2
    [ "$_n" -lt 3 ] && sleep 5
  done
  echo "vendor: download FAILED after 3 attempts: $_url" >&2
  return 1
}

have_all() {
    for f in $FILES; do [ -f "$DIR/$f" ] || return 1; done
}

if have_all; then
    echo "vendor: wasm3 $PIN present"
    exit 0
fi

mkdir -p "$DIR"
TMP=$(mktemp /tmp/dsh-wasm3.XXXXXX)
fetch_retry "$URL" "$TMP"
echo "$TARBALL_SHA256  $TMP" | shasum -a 256 -c - >/dev/null
for f in $FILES; do
    tar xzf "$TMP" -C "$DIR" --strip-components=1 "wasm3-$PIN/$f"
done
rm -f "$TMP"

have_all || { echo "vendor: fetch incomplete — refusing to continue" >&2; exit 1; }
echo "vendor: wasm3 $PIN fetched and verified"
