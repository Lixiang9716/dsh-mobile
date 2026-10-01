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

# fetch_retry <url> <out> — bounded retries around a TRANSIENT download
# failure, window sized for CI's cold materialization (see ensure.sh for the
# measured 504 that cost a CI job): 5 outer attempts, inner curl --retry 2,
# waits 5/10/20/40. Fails loud naming the URL.
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
# and expected digest (the bare-shasum-on-a-mktemp-name death hid which
# package and which source had failed — #289 feedback).
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

have_all() {
    for f in $FILES; do [ -f "$DIR/$f" ] || return 1; done
}

# PIN-STAMPED present-check (the ensure-zstd.sh pattern, issue #180): right
# file NAMES are not right CONTENT — a tree fetched under an older pin keeps
# every name while carrying stale bytes, and tar preserves upstream mtimes so
# the compilers see nothing to rebuild. Stamp = tarball sha256, written only
# after a verified fetch; absence or mismatch forces a re-fetch.
if [ -f "$DIR/.vendor-pin" ] && [ "$(cat "$DIR/.vendor-pin")" = "$TARBALL_SHA256" ] && have_all; then
    echo "vendor: wasm3 $PIN present"
    exit 0
fi

mkdir -p "$DIR"
TMP=$(mktemp /tmp/dsh-wasm3.XXXXXX)
fetch_verified "wasm3 $PIN" "$URL" "$TMP" "$TARBALL_SHA256"
rm -rf "$DIR"
mkdir -p "$DIR"
for f in $FILES; do
    tar xzf "$TMP" -C "$DIR" --strip-components=1 "wasm3-$PIN/$f"
done
rm -f "$TMP"
echo "$TARBALL_SHA256" > "$DIR/.vendor-pin"

have_all || { echo "vendor: fetch incomplete — refusing to continue" >&2; exit 1; }
echo "vendor: wasm3 $PIN fetched and verified"
