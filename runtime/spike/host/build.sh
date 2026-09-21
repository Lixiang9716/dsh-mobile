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
VENDOR=vendor/quickjs-ng/0.17.0
RELEASE=0
[ "${1:-}" = "--release" ] && RELEASE=1
mkdir -p build
if [ "$RELEASE" -eq 1 ]; then
    cc -std=c11 -O1 -D_GNU_SOURCE -DDSH_RELEASE=1 -I"$VENDOR" \
       -o build/dsh-spike-cli-release \
       host/dsh_spike_host.c host/main_cli.c \
       "$VENDOR/dtoa.c" "$VENDOR/libregexp.c" "$VENDOR/libunicode.c" "$VENDOR/quickjs.c" \
       -lm
    echo "built build/dsh-spike-cli-release (-DDSH_RELEASE)"
else
    cc -std=c11 -O1 -D_GNU_SOURCE -I"$VENDOR" \
       -o build/dsh-spike-cli \
       host/dsh_spike_host.c host/main_cli.c \
       "$VENDOR/dtoa.c" "$VENDOR/libregexp.c" "$VENDOR/libunicode.c" "$VENDOR/quickjs.c" \
       -lm
    echo "built build/dsh-spike-cli"
fi
