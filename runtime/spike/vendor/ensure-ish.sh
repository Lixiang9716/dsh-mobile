#!/bin/sh
# Fetch + verify the vendored iSH-arm64 sources — the in-process Linux userland
# the iOS host runs a shell in. Idempotent: exits 0 when the pinned tree is
# already on disk.
#
# Same discipline as ensure-wasm3.sh (and ensure.sh for quickjs-ng): the vendor
# tree is UNTRACKED, the pin lives HERE (commit + tarball sha256), what lands on
# disk is verbatim upstream, and the exclusions below are the record of what is
# deliberately NOT vendored.
#
# Why this engine: iOS forbids spawning a shell binary and this architecture
# refuses subprocesses (D2), so "run a command line" has to happen inside the
# app's own process. iSH is a USERSPACE Linux emulator — it emulates AArch64
# instructions (threaded-code interpreter, no JIT, no RWX memory) and the Linux
# syscall surface, so a real Alpine userland runs in-process with no child
# process and no second OS. The ARM64 guest backend is this fork's contribution
# (upstream iSH emulates i386); the app-facing seam we build on is its kernel
# task API (`become_new_init_child` + `do_execve` + `task_start`), the same one
# the fork's own agent shell uses.
#
# Upstream: https://github.com/OpenMinis/ish-arm64 — a fork of ish-app/ish.
# LICENSE.md + LICENSE.IOS are vendored with the sources.
#
# What is NOT vendored, by name (each is either test fixture, another guest
# arch, or the iOS app target we do not build):
#   app/                     the fork's UIKit app + Xcode project inputs
#   iSH.xcodeproj fastlane   the fork's app build
#   kernel/offload_tests/    prebuilt native-offload fixtures (~17 MB)
#   asbestos/guest-x86/ kernel/arch/x86/ vdso/x86/   the i386 guest backend
#   linux/ deps/             the fork's "real Linux kernel" mode (we use -Dkernel=ish)
#   tests/ benchmark/ bench-legacy/ docs/ tools/prebuilt_gadget_gen/
#
# Run before any build that embeds the engine (macOS CLI today, iOS app too).
# Network is only needed on first fetch.
set -e
cd "$(dirname "$0")"

PIN=e1d579480fba88e8f0428e3cf23811bcdd05421f
TARBALL_SHA256=36d8c4fe66b1fcd80c74a03b21044a935c2324038f9d4f597a25dadc6f4419bb
URL="https://github.com/OpenMinis/ish-arm64/archive/$PIN.tar.gz"

DIR="ish/$PIN"

EXCLUDE="app iSH.xcodeproj fastlane kernel/offload_tests asbestos/guest-x86 \
kernel/arch/x86 vdso/x86 linux deps tests benchmark bench-legacy docs tools/prebuilt_gadget_gen"

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

# The engine is present when every directory the build reads from is there.
have_all() {
    for d in asbestos emu fs kernel util platform vdso tools; do
        [ -d "$DIR/$d" ] || return 1
    done
    [ -f "$DIR/main.c" ] && [ -f "$DIR/LICENSE.md" ]
}

if have_all; then
    echo "vendor: iSH-arm64 $PIN present"
    exit 0
fi

mkdir -p "$DIR"
TMP=$(mktemp /tmp/dsh-ish.XXXXXX.tar.gz)
fetch_retry "$URL" "$TMP"
echo "$TARBALL_SHA256  $TMP" | shasum -a 256 -c - >/dev/null
# Strip the archive's top-level directory and unpack verbatim, then drop the
# excluded trees — the exception list above is the provenance record.
STAGE=$(mktemp -d /tmp/dsh-ish-stage.XXXXXX)
tar xzf "$TMP" -C "$STAGE" --strip-components=1
for p in $EXCLUDE; do rm -rf "$STAGE/$p"; done
rm -rf "$DIR"
mkdir -p "$DIR"
(cd "$STAGE" && tar cf - .) | (cd "$DIR" && tar xf -)
rm -rf "$STAGE" "$TMP"

have_all || { echo "vendor: fetch incomplete — refusing to continue" >&2; exit 1; }
echo "vendor: iSH-arm64 $PIN fetched and verified"
