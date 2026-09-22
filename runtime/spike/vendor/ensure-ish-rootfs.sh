#!/bin/sh
# Fetch + verify the guest USERLAND and place it where an app bundle can carry it.
#
# The pinned Alpine minirootfs is a `.tar.gz`: a tarball is a plain data file, so
# it rides in an app bundle, while the EXTRACTED tree cannot — the userland has
# 335 symlinks, many absolute (`/usr/bin/top -> /bin/busybox`), and installd
# rejects such an app outright (`invalid symlink at …`). The app materializes it
# into its container at first launch with the seam's own extractor
# (`dsh_ish_stage`, gzip via zlib — iOS has no `tar`).
#
# Same discipline as ensure-ish.sh / ensure-wasm3.sh: the destination is
# UNTRACKED, the pin lives HERE (URL + sha256), and what lands on disk is the
# upstream artifact byte for byte.
#
#   sh runtime/spike/vendor/ensure-ish-rootfs.sh [DEST_DIR]
#
# Default destination is the app's resource staging directory; the iOS build
# phase copies it into the bundle. Idempotent, and the checksum is verified on
# every run (a corrupted cache must not silently become a guest root).
set -e

DEST="${1:-$(cd "$(dirname "$0")/../../.." && pwd)/hosts/ios/App/Generated}"
FILE="ish-rootfs.tar.gz"

# Alpine 3.21.8 aarch64 minirootfs — the same image the desktop e2e fetches
# (tools/e2e/run-ish-local.sh carries the identical pin; the guest identity the
# scenario asserts is this release's).
URL=https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/aarch64/alpine-minirootfs-3.21.8-aarch64.tar.gz
SHA256=f25a96d2846a4bc439093107c1b48a8b0c93dcb411e2cb9cfded6f790b2bc001

mkdir -p "$DEST"
TARGET="$DEST/$FILE"

have_valid() {
    [ -f "$TARGET" ] || return 1
    echo "$SHA256  $TARGET" | shasum -a 256 -c - >/dev/null 2>&1
}

if have_valid; then
    echo "ish-rootfs: $TARGET present and verified"
    exit 0
fi

TMP="$TARGET.tmp"
n=0
while [ "$n" -lt 3 ]; do
    n=$((n + 1))
    if curl -fL --retry 3 --retry-delay 5 --connect-timeout 20 "$URL" -o "$TMP" 2>/dev/null; then
        break
    fi
    echo "ish-rootfs: download attempt $n/3 failed: $URL" >&2
    [ "$n" -lt 3 ] && sleep 5
done
[ -f "$TMP" ] || { echo "ish-rootfs: download FAILED after 3 attempts" >&2; exit 1; }

echo "$SHA256  $TMP" | shasum -a 256 -c - >/dev/null
mv "$TMP" "$TARGET"
echo "ish-rootfs: fetched and verified $TARGET ($(wc -c <"$TARGET" | tr -d ' ') bytes)"
