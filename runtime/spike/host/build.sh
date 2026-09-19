#!/bin/sh
# Build the M1 spike desktop CLI (macOS/Linux proof run for the core spike).
# Platforms do NOT use this script — they compile the same sources through
# their own build systems (Xcode / CMake-NDK / hvigor NAPI), each after
# running runtime/spike/vendor/ensure.sh first.
set -e
cd "$(dirname "$0")/.."
./vendor/ensure.sh
VENDOR=vendor/quickjs-ng/0.17.0
mkdir -p build
cc -std=c11 -O1 -D_GNU_SOURCE -I"$VENDOR" \
   -o build/dsh-spike-cli \
   host/dsh_spike_host.c host/main_cli.c \
   "$VENDOR/dtoa.c" "$VENDOR/libregexp.c" "$VENDOR/libunicode.c" "$VENDOR/quickjs.c" \
   -lm
echo "built build/dsh-spike-cli"
