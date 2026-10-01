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
PIN=0.17.0+fork-tostring+async-context+tc39+promise-mark
QJS_REPO=Lixiang9716/quickjs
# #239 re-pin (2026-09-29, 4153a1f0 -> 63b33ea5): js_promise_mark now marks
# the reaction's captured async_context (unmarked, it read as an eternal
# external root and pinned frame arrays through JS_FreeRuntime — teardown
# SIGABRT), and promise_reaction_data_free no longer reads rd->async_context
# after freeing the record (the out-of-band vendor reorder is now IN the
# fork, so the pin is self-contained again).
COMMIT=63b33ea5a7a53fedebd05c3413f2ee556e60f849
TARBALL_SHA256=63310bdbd9dc153c489db98f1c0fb840e69f67f4c52c5945ad915ab275a58408

# fetch_retry <url> <out> — bounded retries around a TRANSIENT download
# failure, with the window sized for CI's cold materialization: when neither
# the CI cache nor a local tree has the bytes, the runner's network is the
# ONLY path, and a blip there must not sink the job (measured: one upstream
# `curl: (56) ... 504` failed an entire CI job, run 35614651794, and did not
# recur). 5 outer attempts, inner curl --retry 2, waits of 5/10/20/40 between
# them — ~75s of pacing plus up to 15 dials worst case, still bounded.
# `--retry` alone does not cover a 504; that is why the outer loop states the
# policy where it can be read.
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

# fetch_verified <label> <url> <out> <sha256> — the download WITH its
# integrity check, retried as one bounded unit. A 200 with a truncated or
# corrupt body passes curl's exit code, so the digest check must sit inside
# the retry window (a retry policy ABOVE verification would just accept a
# bad artifact more persistently): a digest mismatch refetches, and three
# mismatches fail loud naming the label, the source URL, and the expected
# digest — never a bare shasum line on a mktemp filename (that cryptic death
# is exactly what swallowed failures looked like downstream, #289 feedback).
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

# The vendor DIRECTORY stays quickjs-ng/0.17.0 regardless of the pin's
# display suffix (every build file — host/build.sh, the harmony CMakeLists,
# the iOS project — hardcodes this path; a suffix-coupled rename broke the
# harmony build exactly once before the decoupling).
DIR="quickjs-ng/0.17.0"

FILES="dtoa.c libregexp.c libunicode.c quickjs.c \
cutils.h dtoa.h libregexp.h libregexp-opcode.h libunicode.h libunicode-table.h \
list.h quickjs.h quickjs-atom.h quickjs-opcode.h quickjs-c-atomics.h \
builtin-array-fromasync.h builtin-iterator-zip.h builtin-iterator-zip-keyed.h \
LICENSE"

have_all() {
    for f in $FILES; do [ -f "$DIR/$f" ] || return 1; done
}

# The present-check is PIN-STAMPED (the ensure-zstd.sh pattern): a tree that
# merely has the right FILE NAMES is not proof of the right CONTENT — a
# tree fetched under an older pin keeps every name while carrying stale
# bytes, and tar restores upstream mtimes so the platform compilers see
# nothing to rebuild. That exact failure shipped a pre-async-context
# quickjs into local builds while every agent turn died at the shim
# (issue #180). The stamp is the tarball sha256, written only after a
# verified fetch; its absence or mismatch forces a re-fetch.
if [ -f "$DIR/.vendor-pin" ] && [ "$(cat "$DIR/.vendor-pin")" = "$TARBALL_SHA256" ] && have_all; then
    echo "vendor: quickjs-ng $PIN present ($COMMIT)"
    exit 0
fi

mkdir -p "$DIR"
TMP=$(mktemp /tmp/dsh-qjs.XXXXXX)
fetch_verified "quickjs-ng $PIN (fork $QJS_REPO@$COMMIT)" \
    "https://github.com/$QJS_REPO/archive/$COMMIT.tar.gz" "$TMP" "$TARBALL_SHA256"
rm -rf "$DIR"
mkdir -p "$DIR"
for f in $FILES; do
    tar xzf "$TMP" -C "$DIR" --strip-components=1 "quickjs-$COMMIT/$f"
done
rm -f "$TMP"
echo "$TARBALL_SHA256" > "$DIR/.vendor-pin"

have_all || { echo "vendor: fetch incomplete — refusing to continue" >&2; exit 1; }
echo "vendor: quickjs-ng $PIN fetched and verified ($COMMIT)"
