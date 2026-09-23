#!/bin/sh
# Build the M1 spike desktop CLI (macOS/Linux proof run for the core spike).
# Platforms do NOT use this script — they compile the same sources through
# their own build systems (Xcode / CMake-NDK / hvigor NAPI), each after
# running runtime/spike/vendor/ensure.sh first.
#
# Two variants, one per logging regime (the same split the platform Release
# configurations produce, so this CLI is how the strip is verified on the
# cheapest host):
#   build.sh            → build/dsh-spike-cli          (debug: full logging)
#   build.sh --release  → build/dsh-spike-cli-release  (-DDSH_RELEASE: the
#                         shared host injects globalThis.__DSH_RELEASE__)
set -e
cd "$(dirname "$0")/.."
./vendor/ensure.sh
# The in-process Linux userland (contract v1.3.0 `ishRun`) is the one part of
# this build with its own build system on purpose: 400k lines of vendored C with
# hand-written aarch64 assembly, built for macOS and for both iOS SDKs from one
# CMake project (host/ish/CMakeLists.txt). The CLI links that output the same way
# the app does, which is why the local E2E exercises the engine the app ships.
ISH_BUILD=build/ish
if [ ! -f "$ISH_BUILD/libishcore.a" ] || [ ! -f "$ISH_BUILD/libdsh_ish.a" ]; then
    cmake -S host/ish -B "$ISH_BUILD" -DISH_VENDOR="$PWD/vendor" >/dev/null
    cmake --build "$ISH_BUILD" --target ishcore dsh_ish -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" >/dev/null
fi
# -lz is the seam's own dependency: dsh_ish_stage() inflates the pinned guest
# userland tarball with zlib (iOS ships libz, macOS has it in the SDK). It is
# not part of the engine's link interface, so it has to be named here.
ISH_LIBS="-L$ISH_BUILD -ldsh_ish -lishcore -lsqlite3 -lz -lresolv"
VENDOR=vendor/quickjs-ng/0.17.0
# Vendored zstd (vendor/ensure-zstd.sh is the pin record): compiled straight
# into the shared host — SINGLE-THREADED (no ZSTD_MULTITHREAD: one serial
# runtime thread is the constitution, D2). The globs track the vendored
# subset exactly; zstd.h/zstd_errors.h sit at the pin root, the rest of the
# headers in common/ (hence the two -I flags, the same include set every
# platform build must pass when it compiles these same host sources).
ZSTD=vendor/zstd/1.5.7
ZSTD_SRC="$ZSTD/common/*.c $ZSTD/compress/*.c $ZSTD/decompress/*.c"
RELEASE=0
[ "${1:-}" = "--release" ] && RELEASE=1
mkdir -p build
# -DZSTD_DISABLE_ASM: the vendored subset carries no huf_decompress_amd64.S,
# and on an x86_64 build (Intel Mac / x86_64 Linux) the asm dispatch would
# reference undefined HUF_*_fast_asm_loop symbols at link time — the same
# define every platform build passes.
if [ "$RELEASE" -eq 1 ]; then
    cc -std=c11 -O1 -D_GNU_SOURCE -DDSH_RELEASE=1 -DZSTD_DISABLE_ASM=1 \
       -I"$VENDOR" -I"$ZSTD" -I"$ZSTD/common" \
       -o build/dsh-spike-cli-release \
       host/dsh_spike_host.c host/main_cli.c \
       "$VENDOR/dtoa.c" "$VENDOR/libregexp.c" "$VENDOR/libunicode.c" "$VENDOR/quickjs.c" \
       $ZSTD_SRC \
       $ISH_LIBS -lm
    echo "built build/dsh-spike-cli-release (-DDSH_RELEASE)"
else
    cc -std=c11 -O1 -D_GNU_SOURCE -DZSTD_DISABLE_ASM=1 \
       -I"$VENDOR" -I"$ZSTD" -I"$ZSTD/common" \
       -o build/dsh-spike-cli \
       host/dsh_spike_host.c host/main_cli.c \
       "$VENDOR/dtoa.c" "$VENDOR/libregexp.c" "$VENDOR/libunicode.c" "$VENDOR/quickjs.c" \
       $ZSTD_SRC \
       $ISH_LIBS -lm
    echo "built build/dsh-spike-cli"
fi
