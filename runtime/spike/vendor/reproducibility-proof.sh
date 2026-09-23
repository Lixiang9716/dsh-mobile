#!/bin/sh
# reproducibility-proof.sh — the fresh-clone proof for the vendor scripts.
#
# The 2026-09-23/24 CI campaign exposed a failure CLASS local gates could not
# see: vendor/test-asset materialization scripts that work in a dev tree but
# break under CI's exact invocation shape from a fresh clone (a caller-relative
# mirror path, a vendor DIR decoupled from the pin, double-prefixed npm names,
# BSD mktemp interior-X templates, hand-staged dev-tree copies masking fetch
# gaps). Seven CI failures, one class — every one invisible to a dev-tree run.
#
# This proof makes the CLASS mechanically caught. From a scratch clone of the
# current commit — vendor trees are untracked (D6), so a clone is genuinely
# cold — it runs the materialization scripts exactly the way CI calls them
# (repo root, relative paths, mixed direct/sh spellings), runs each script a
# SECOND time (the mktemp class only fires on re-invocation), then verifies
# the result against the pin tables the scripts themselves declare: every
# declared row must exist on disk as a directory stamped with THAT row's
# digest — "the directory exists" is not evidence (the upstream re-cut
# surprise).
#
# Two scopes (signal per minute):
#   --gate   ensure.sh + ensure-dsh.sh: the engines, the mirror-served DSH
#            closure (network-free: dsh-tarballs/ is tracked), and the 9 npm
#            closure rows. ~2 min; wired as the always-run vendoring-repro
#            gate.
#   (full)   adds ensure-dsh-tests.sh: the ~25 MB codeload tarball plus its
#            ~190-row npm leg (~192 sequential fetches) — the exact leg the
#            double-prefixed-name bug broke. Too slow for every PR; run by
#            .github/workflows/vendor-repro.yml on a weekly schedule and on
#            demand.
#
# Cost of the full scope is real downloads (~30 MB): the price of proving the
# promise instead of trusting it.
set -eu

SCOPE=full
[ "${1:-}" = "--gate" ] && SCOPE=gate

VENDOR_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$VENDOR_DIR/../../.." && pwd)"
ENSURE_DSH="runtime/spike/vendor/ensure-dsh.sh"
ENSURE_DSH_TESTS="runtime/spike/vendor/ensure-dsh-tests.sh"
SCRATCH="$(mktemp -d /tmp/dsh-vend-repro.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
trap 'rm -rf "$SCRATCH"; exit 1' INT TERM

say() { echo "vend-repro: $*"; }
die() { echo "vend-repro: FAIL — $*" >&2; exit 1; }

# First-match scalar out of an ensure script's pin block (tolerates quoted and
# bare spellings). Empty match = the proof's parse rotted; the caller's
# [ -n ] check fails loud on it (rule 5).
pin_var() { # pin_var <file> <name>
    sed -n "s/^$2=\"\{0,1\}\([^\"]*\)\"\\{0,1\\}.*/\1/p" "$1" | head -n 1
}

# ---- 1. the fresh clone ----------------------------------------------------
say "scope=$SCOPE — fresh clone of $(git -C "$REPO_ROOT" rev-parse HEAD) -> $SCRATCH/clone"
git clone --depth 1 --quiet "file://$REPO_ROOT" "$SCRATCH/clone" \
    || die "git clone of the working repository failed"
cd "$SCRATCH/clone"

# ---- 2. CI's invocation shapes ---------------------------------------------
# gov.yml: `runtime/spike/vendor/ensure.sh` + `runtime/spike/vendor/ensure-dsh.sh`
# from the repo root (direct exec); the dev-* workflows call the same scripts
# as `sh <relative path>` from the repo root. Both spellings, always repo-root
# cwd — the exact shape the caller-relative mirror path broke under.
say "materializing from cold (clone root, CI shapes)"
sh runtime/spike/vendor/ensure.sh \
    || die "ensure.sh failed from a fresh clone"
runtime/spike/vendor/ensure-dsh.sh \
    || die "ensure-dsh.sh failed from a fresh clone"
if [ "$SCOPE" = full ]; then
    sh runtime/spike/vendor/ensure-dsh-tests.sh \
        || die "ensure-dsh-tests.sh failed from a fresh clone"
fi

# ---- 3. idempotency (second run) --------------------------------------------
# A dev tree re-runs these scripts on every build; BSD mktemp once turned that
# second invocation into "File exists". A script that cannot survive its own
# re-invocation is not CI-safe.
say "re-running (idempotency)"
sh runtime/spike/vendor/ensure.sh \
    || die "ensure.sh is not idempotent"
runtime/spike/vendor/ensure-dsh.sh >/dev/null \
    || die "ensure-dsh.sh is not idempotent"
if [ "$SCOPE" = full ]; then
    sh runtime/spike/vendor/ensure-dsh-tests.sh >/dev/null \
        || die "ensure-dsh-tests.sh is not idempotent"
fi

# ---- 4. the pin tables describe the tree ------------------------------------
V="runtime/spike/vendor"

# 4a. the DSH closure rows of ensure-dsh.sh (`name|ver|sha`).
DSH_RX='^[a-z][a-z0-9-]*\|[0-9A-Za-z.+-]+\|[0-9a-f]{64}$'
DSH_ROWS=$(grep -cE "$DSH_RX" "$ENSURE_DSH" || true)
[ "$DSH_ROWS" -gt 0 ] || die "parsed 0 dsh pin rows from $ENSURE_DSH — the proof's table parse rotted"
grep -E "$DSH_RX" "$ENSURE_DSH" | while IFS='|' read -r name ver sha; do
    stamp="$V/dsh/$name@$ver/.vendor-pin"
    [ -f "$stamp" ] || die "dsh row $name@$ver: missing pin stamp $stamp"
    [ "$(cat "$stamp")" = "$sha" ] || die "dsh row $name@$ver: stamp does not name the pinned sha (drift)"
done
say "dsh closure: $DSH_ROWS pin rows verified (mirror-served, sha-stamped)"

# 4b. the third-party npm rows of ensure-dsh.sh (`dir|...tgz|sha`).
NPM_RX='\|[^|]*\.tgz\|[0-9a-f]{64}$'
NPM_ROWS=$(grep -cE "$NPM_RX" "$ENSURE_DSH" || true)
[ "$NPM_ROWS" -gt 0 ] || die "parsed 0 npm pin rows from $ENSURE_DSH — the proof's table parse rotted"
grep -E "$NPM_RX" "$ENSURE_DSH" | while IFS='|' read -r dir suffix sha; do
    stamp="$V/npm/$dir/.vendor-pin"
    [ -f "$stamp" ] || die "npm row $dir: missing pin stamp $stamp"
    [ "$(cat "$stamp")" = "$sha" ] || die "npm row $dir: stamp does not name the pinned sha (drift)"
done
say "npm closure: $NPM_ROWS pin rows verified"

# 4c. the upstream test assets (ensure-dsh-tests.sh): the codeload stamp plus
# every ensure_npm row (`ensure_npm "name" "ver" "sha"`). Full scope only —
# this is the ~190-fetch leg the scheduled workflow exists to prove.
if [ "$SCOPE" = full ]; then
    TESTS_TAG=$(pin_var "$ENSURE_DSH_TESTS" TAG)
    TESTS_SHA=$(pin_var "$ENSURE_DSH_TESTS" TARBALL_SHA256)
    [ -n "$TESTS_TAG" ] && [ -n "$TESTS_SHA" ] \
        || die "could not parse TAG/TARBALL_SHA256 from $ENSURE_DSH_TESTS — the proof's parse rotted"
    TESTS_STAMP="$V/dsh-tests@$TESTS_TAG/.vendor-pin"
    grep -q "$TESTS_SHA" "$TESTS_STAMP" 2>/dev/null \
        || die "test assets: $TESTS_STAMP missing or does not name the pinned tarball sha"
    TNPM_RX='^ensure_npm "[^"]+" "[^"]+" "[0-9a-f]{64}"'
    TNPM_ROWS=$(grep -cE "$TNPM_RX" "$ENSURE_DSH_TESTS" || true)
    [ "$TNPM_ROWS" -gt 0 ] || die "parsed 0 ensure_npm rows from $ENSURE_DSH_TESTS — the proof's table parse rotted"
    grep -E "$TNPM_RX" "$ENSURE_DSH_TESTS" \
        | sed -E 's/^ensure_npm "([^"]+)" "([^"]+)" "([0-9a-f]{64})"/\1 \2 \3/' \
        | while read -r name ver sha; do
            stamp="$V/npm/@deepseek-ai/$name@$ver/.vendor-pin"
            grep -q "$sha" "$stamp" 2>/dev/null \
                || die "test npm row $name@$ver: $stamp missing or does not name the pinned sha"
        done
    say "test assets: codeload + $TNPM_ROWS ensure_npm rows verified"
fi

# 4d. the engines (ensure.sh -> quickjs-ng/wasm3/zstd): the exact artifacts
# the platform builds include. dtoa.c is the file whose absence broke the
# harmony build when the vendor DIR decoupled from the pin suffix.
QJS_DIR=$(pin_var "$VENDOR_DIR/ensure.sh" DIR)
[ -n "$QJS_DIR" ] || die "could not parse DIR from ensure.sh — the proof's parse rotted"
for f in dtoa.c quickjs.c quickjs.h cutils.h LICENSE; do
    [ -f "$V/$QJS_DIR/$f" ] || die "quickjs-ng: $V/$QJS_DIR/$f missing (the decoupled-DIR break)"
done
WASM_PIN=$(pin_var "$VENDOR_DIR/ensure-wasm3.sh" PIN)
[ -n "$WASM_PIN" ] || die "could not parse PIN from ensure-wasm3.sh — the proof's parse rotted"
for f in source/m3_core.c source/m3_exec.c source/wasm3.h; do
    [ -f "$V/wasm3/$WASM_PIN/$f" ] || die "wasm3: $V/wasm3/$WASM_PIN/$f missing"
done
ZSTD_VER=$(pin_var "$VENDOR_DIR/ensure-zstd.sh" VERSION)
ZSTD_SHA=$(pin_var "$VENDOR_DIR/ensure-zstd.sh" TARBALL_SHA256)
[ -n "$ZSTD_VER" ] && [ -n "$ZSTD_SHA" ] \
    || die "could not parse VERSION/TARBALL_SHA256 from ensure-zstd.sh — the proof's parse rotted"
[ -f "$V/zstd/$ZSTD_VER/zstd.h" ] || die "zstd: $V/zstd/$ZSTD_VER/zstd.h missing"
[ "$(cat "$V/zstd/$ZSTD_VER/.vendor-pin")" = "$ZSTD_SHA" ] \
    || die "zstd: stamp does not name the pinned sha (drift)"
say "engines: quickjs-ng $QJS_DIR + wasm3 $WASM_PIN + zstd $ZSTD_VER verified"

say "PASS ($SCOPE scope) — the vendor scripts materialize what they promise, from a fresh clone, under CI's invocation shapes"
