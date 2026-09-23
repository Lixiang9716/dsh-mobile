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
# The zstd C library (node:zlib's zstd face rides it through the host
# intrinsics + the node:zlib shim) — same pin terms.
sh ./ensure-zstd.sh

# The ENGINE PIN lives at OUR fork (owner direction 2026-09-23: dsh-mobile
# maintains its own quickjs; #163 pinned it first and #169's merge silently
# reverted the pin to upstream — restored here at the TWO-divergence head).
# The fork = upstream quickjs-ng 0.17.0 (6d46d07d) + (1) native
# Function.prototype.toString renders the single-line V8/JSC form (the
# dsh-util-values realm guard string-compares that spelling; on stock
# quickjs-ng every plain object fails the realm check — anywhere-labs/
# dsh-desktop#1157), and (2) the async-context engine surface (TC39
# proposal-async-context shape): a per-runtime context value snapshotted
# into every enqueued job and captured at promise-reaction ATTACH time —
# the await-boundary propagation JS patches cannot reach — now exposed as
# the TC39 proposal-async-context face itself: AsyncContext.Variable /
# snapshot / wrap as an ENGINE INTRINSIC (JS_AddIntrinsicAsyncContext),
# upstreamable to quickjs-ng as-is. Rebase the branch when tracking a
# newer quickjs-ng.
PIN=0.17.0+fork-tostring+async-context+tc39
QJS_REPO=Lixiang9716/quickjs
COMMIT=$(cd /tmp/qjs-fork && git rev-parse HEAD)
TARBALL_SHA256=c635c1e73629b6a69043b09ba181b69a679b4341f9cb6a012d47b83dce6a4f57

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

DIR="quickjs-ng/$PIN"

FILES="dtoa.c libregexp.c libunicode.c quickjs.c \
cutils.h dtoa.h libregexp.h libregexp-opcode.h libunicode.h libunicode-table.h \
list.h quickjs.h quickjs-atom.h quickjs-opcode.h quickjs-c-atomics.h \
builtin-array-fromasync.h builtin-iterator-zip.h builtin-iterator-zip-keyed.h \
LICENSE"

have_all() {
    for f in $FILES; do [ -f "$DIR/$f" ] || return 1; done
}

if have_all; then
    echo "vendor: quickjs-ng $PIN present ($COMMIT)"
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
echo "vendor: quickjs-ng $PIN fetched and verified ($COMMIT)"
