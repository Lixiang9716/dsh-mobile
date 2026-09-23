#!/bin/sh
# Fetch + verify the vendored quickjs-ng engine sources. Idempotent: exits 0
# when the pinned sources are already present on disk.
#
# The vendor tree is UNTRACKED (gitignored) by design: the engine's real-world
# C cannot survive a tree-sitter editor-level parse gate, and compile truth
# belongs to the platform compilers anyway. The pin lives HERE — commit sha +
# tarball sha256 — so what lands on disk is always verbatim upstream.
#
# Run before any build that embeds the engine (desktop CLI, iOS, Android,
# HarmonyOS NAPI). Network is only needed on first fetch.
set -e
cd "$(dirname "$0")"

# The other engine this repository embeds — the WebAssembly interpreter — has
# its own pin record (ensure-wasm3.sh). Vendoring the engines is ONE step at
# every call site, so this script delegates rather than duplicating the
# fetch-and-verify logic; a caller that wants only quickjs can run that script
# on its own.
sh ./ensure-wasm3.sh   # cwd is this script's directory (cd above)

# The ENGINE PIN lives at OUR fork (owner decision 2026-09-23: dsh-mobile
# maintains its own quickjs). The fork = upstream quickjs-ng 0.17.0
# (6d46d07d) + exactly one divergence, on branch dsh-native-tostring:
# native Function.prototype.toString renders the single-line V8/JSC form
# ("function Object() { [native code] }") instead of quickjs's multi-line
# indented form — the dsh-util-values realm guard string-compares the
# single-line spelling, so on stock quickjs-ng every plain object fails
# the realm check and Session creation rejects every header. Upstream
# issue filed (anywhere-labs/dsh-desktop#1157; deepseek-harness has issues
# disabled). Rebase the branch when tracking a newer quickjs-ng.
PIN=0.17.0+fork-tostring
COMMIT=98395e3e6f97250fcb4af2855d644f1f6a6fd0a0
TARBALL_SHA256=da580adf9acd0fecc4e5795a039076a5073b8ea8164b4fa03c0ba8996544edc0
QJS_REPO=Lixiang9716/quickjs

# fetch_retry <url> <out> — bounded retries around a TRANSIENT download failure.
#
# Measured: one upstream `curl: (56) The requested URL returned error: 504`
# failed an entire CI job (run 35614651794, the iOS "Vendor quickjs-ng + the
# pinned upstream DSH closure" step) and did not recur — transient, not
# systemic. `--retry` alone does not cover it: that retries connection blips,
# while a 504 from the origin or a proxy is not reliably in its retry set.
#
# The integrity check is deliberately NOT part of this: every caller still
# verifies sha256 over what lands, so a retry can never turn a corrupt or
# truncated download into an accepted one. Bounded at 3 attempts, and it fails
# loud naming the URL.
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

DIR="quickjs-ng/0.17.0"

FILES="dtoa.c libregexp.c libunicode.c quickjs.c \
cutils.h dtoa.h libregexp.h libregexp-opcode.h libunicode.h libunicode-table.h \
list.h quickjs.h quickjs-atom.h quickjs-opcode.h quickjs-c-atomics.h \
builtin-array-fromasync.h builtin-iterator-zip.h builtin-iterator-zip-keyed.h \
LICENSE"

have_all() {
    for f in $FILES; do [ -f "$DIR/$f" ] || return 1; done
}

# A pin-stamp carries the same discipline the dsh closure has: a restored
# cache directory is VERIFIED, never trusted (a stale or partial tree must
# not short-circuit the fetch with the new commit merely echoed — measured
# 2026-09-23 on the harmony runner: "present (98395e3…)" over a cache whose
# tree predated the fork, then cmake died on a missing source file).
if [ -f "$DIR/.vendor-pin" ] && [ "$(cat "$DIR/.vendor-pin")" = "$COMMIT" ] && have_all; then
    echo "vendor: quickjs-ng $PIN present (pin-stamped, $COMMIT)"
    exit 0
fi

mkdir -p "$DIR"
TMP=$(mktemp /tmp/dsh-qjs.XXXXXX.tar.gz)
fetch_retry "https://github.com/$QJS_REPO/archive/$COMMIT.tar.gz" "$TMP"
echo "$TARBALL_SHA256  $TMP" | shasum -a 256 -c - >/dev/null
for f in $FILES; do
    tar xzf "$TMP" -C "$DIR" --strip-components=1 "quickjs-$COMMIT/$f"
done
rm -f "$TMP"

have_all || { echo "vendor: fetch incomplete — refusing to continue" >&2; exit 1; }
echo "$COMMIT" > "$DIR/.vendor-pin"
echo "vendor: quickjs-ng $PIN fetched and verified ($COMMIT)"
