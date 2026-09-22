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
RELEASE=0
[ "${1:-}" = "--release" ] && RELEASE=1
mkdir -p build
if [ "$RELEASE" -eq 1 ]; then
    cc -std=c11 -O1 -D_GNU_SOURCE -DDSH_RELEASE=1 -I"$VENDOR" \
       -o build/dsh-spike-cli-release \
       host/dsh_spike_host.c host/main_cli.c \
       "$VENDOR/dtoa.c" "$VENDOR/libregexp.c" "$VENDOR/libunicode.c" "$VENDOR/quickjs.c" \
       $ISH_LIBS -lm
    echo "built build/dsh-spike-cli-release (-DDSH_RELEASE)"
else
    cc -std=c11 -O1 -D_GNU_SOURCE -I"$VENDOR" \
       -o build/dsh-spike-cli \
       host/dsh_spike_host.c host/main_cli.c \
       "$VENDOR/dtoa.c" "$VENDOR/libregexp.c" "$VENDOR/libunicode.c" "$VENDOR/quickjs.c" \
       $ISH_LIBS -lm
    echo "built build/dsh-spike-cli"
fi
