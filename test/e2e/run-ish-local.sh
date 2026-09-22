#!/bin/sh
# Local E2E for the in-process Linux userland (contract v1.3.0 `ishRun`):
# a real aarch64 Alpine userland booted INSIDE the host process, driven from the
# JS layer through the shipped plugin's own executor.
#
# Two gates, deliberately layered, because "it failed" is not a diagnosis:
#
#   1. the C gate — runtime/spike/build/ish/ish-smoke boots the guest and runs
#      commands straight through the seam (no JS, no simulator);
#   2. the JS gate — the desktop CLI runs scenario/userland-shell.js, which goes
#      scenario → plugin executor → gateway `ishRun` → the host backend → the
#      guest, and whose records test/e2e/scenarios/userland-shell-local.json matches
#      one-to-one.
#
# And then the part the logs cannot carry on their own: the DELIVERABLE. The
# guest writes a file into the workspace, the JS layer reads it back through the
# gateway and logs its digest, and this script compares the file on disk with the
# expected bytes — so a green run means the guest's filesystem effects are real
# host files, not a transcript of one.
#
#   test/e2e/run-ish-local.sh [--art-dir DIR] [--rootfs DIR] [--skip-build]
#
# `--rootfs` points at an already-extracted Alpine userland; without it the
# pinned minirootfs is fetched (sha256-verified) into ~/dsh-verify/ish-rootfs.
set -e
cd "$(dirname "$0")/../.."

ART=runtime/spike/artifacts/macos-cli-userland-shell
ROOTFS=""
ROOTFS_OVERRIDE=0
SKIP_BUILD=0
while [ $# -gt 0 ]; do
    case "$1" in
        --art-dir) ART="$2"; shift 2 ;;
        --rootfs) ROOTFS="$2"; ROOTFS_OVERRIDE=1; shift 2 ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        *) echo "run-ish-local: unknown argument '$1'" >&2; exit 2 ;;
    esac
done

case "$ART" in
    /tmp/*) echo "run-ish-local: --art-dir must not be under /tmp (evidence lives with the repo)" >&2; exit 2 ;;
esac

# The paths below are consumed by processes that do NOT share this shell's cwd
# (the CLI gate runs inside a subshell that cd's to runtime/spike), and the host
# layer resolves the workspace with realpath before mounting it. A relative path
# therefore reaches dsh_ish_boot as something that does not resolve, boot fails,
# and the primitive rejects with `io` — a whole gate lost to one un-absolutized
# variable. Absolutize both now, at the single place they are read.
case "$ART" in /*) ;; *) ART="$PWD/$ART" ;; esac
case "$ROOTFS" in ""|/*) ;; *) ROOTFS="$PWD/$ROOTFS" ;; esac

# The pinned guest userland. Alpine 3.21 aarch64 minirootfs: busybox (sh, ls,
# cat, sort, tr, id …), musl, apk — the smallest thing that is honestly a Linux.
ROOTFS_URL=https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/aarch64/alpine-minirootfs-3.21.8-aarch64.tar.gz
ROOTFS_SHA256=f25a96d2846a4bc439093107c1b48a8b0c93dcb411e2cb9cfded6f790b2bc001
DELIVERABLE=ish-deliverable.txt
EXPECTED_TEXT="deliverable from the emulated guest"

mkdir -p "$ART"
WORKSPACE="$ART/workspace"
rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE"

echo "== 1/5 vendor + build =="
if [ "$SKIP_BUILD" -eq 0 ]; then
    sh runtime/spike/vendor/ensure-ish.sh
    cmake -S runtime/spike/host/ish -B runtime/spike/build/ish -DISH_VENDOR="$PWD/runtime/spike/vendor" >/dev/null
    cmake --build runtime/spike/build/ish --target ishcore dsh_ish ish-smoke \
        -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" >/dev/null
    sh runtime/spike/host/build.sh >/dev/null
fi

echo "== 2/5 guest root =="
if [ -z "$ROOTFS" ]; then
    ROOTFS="$HOME/dsh-verify/ish-rootfs"
    if [ ! -f "$ROOTFS/bin/busybox" ]; then
        echo "   fetching the pinned Alpine minirootfs"
        TMP=$(mktemp /tmp/dsh-ish-rootfs.XXXXXX.tar.gz)
        curl -fL --retry 3 --connect-timeout 20 "$ROOTFS_URL" -o "$TMP"
        echo "$ROOTFS_SHA256  $TMP" | shasum -a 256 -c - >/dev/null
        rm -rf "$ROOTFS"
        mkdir -p "$ROOTFS"
        # Extracted with Python rather than tar: the tarball's device nodes cannot
        # be created unprivileged (and iSH synthesizes /dev itself), so the
        # extractor skips them instead of failing the run.
        python3 - "$TMP" "$ROOTFS" <<'PY'
import sys, tarfile
src, dst = sys.argv[1], sys.argv[2]
with tarfile.open(src) as t:
    for member in t.getmembers():
        if member.isdev() or member.ischr() or member.isblk() or member.isfifo():
            continue
        t.extract(member, dst, filter='tar')
PY
        rm -f "$TMP"
    fi
fi
echo "   guest root: $ROOTFS"
[ -f "$ROOTFS/bin/busybox" ] || { echo "run-ish-local: $ROOTFS has no /bin/busybox — not an Alpine userland" >&2; exit 2; }

# The produced userland is STAGED FROM THE PINNED TARBALL, not handed over as an
# already-extracted tree: that is the production path on iOS, where the app has no
# `tar`, the bundle cannot carry 335 absolute symlinks, and the seam's own extractor
# (dsh_ish_stage, gzip via zlib) materializes the userland into the container.
# Running the gates on a staged tree is what keeps that code honest — it is
# exercised on every run, on the platform where it is easiest to debug.
echo "== 2b/5 stage the userland from its pinned tarball =="
if [ "$ROOTFS_OVERRIDE" -eq 0 ]; then
    TARBALL="$HOME/dsh-verify/ish-rootfs.tar.gz"
    if [ ! -f "$TARBALL" ]; then
        echo "   fetching the pinned minirootfs tarball"
        curl -fL --retry 3 --connect-timeout 20 "$ROOTFS_URL" -o "$TARBALL"
    fi
    echo "$ROOTFS_SHA256  $TARBALL" | shasum -a 256 -c - >/dev/null
    STAGED="$ART/guest-root"
    rm -rf "$STAGED"
    runtime/spike/build/ish/ish-smoke --stage "$TARBALL" "$STAGED" > "$ART/stage.jsonl"
    grep -q "dsh_ish_stage: .* links" "$ART/stage.jsonl"
    [ -x "$STAGED/bin/busybox" ] || { echo "   FAIL: the staged tree has no executable busybox" >&2; exit 1; }
    [ -L "$STAGED/usr/bin/top" ] || { echo "   FAIL: the staged tree lost its symlinks" >&2; exit 1; }
    [ -f "$STAGED/etc/resolv.conf" ] || { echo "   FAIL: no resolver seeded" >&2; exit 1; }
    echo "   staged: $(grep 'dsh_ish_stage:' "$ART/stage.jsonl" | tail -1)"
    grep -q 'dsh_ish_verify: verdict=stage-sealed' "$ART/stage.jsonl" \
        || { echo "   FAIL: staging sealed no manifest" >&2; exit 1; }
    ROOTFS="$STAGED"

    # The rejection case "integrity at every mount" owes the matrix (rule 6:
    # a verify that never failed is not evidence): append one byte to the
    # SEALED busybox and demand the boot refuse it with a structured record
    # naming the entry and the expected digest. The byte goes straight back
    # so the gates below boot the real userland. Staged-flow only — an
    # override tree has no manifest until its first boot seals it.
    TAMPER="$ART/verify-tamper.jsonl"
    cp -p "$STAGED/bin/busybox" "$ART/busybox.pristine"
    printf 'x' >> "$STAGED/bin/busybox"
    if runtime/spike/build/ish/ish-smoke --rootfs "$STAGED" -c 'true' > "$TAMPER" 2>&1; then
        echo "   FAIL: the guest booted a tampered userland" >&2; exit 1
    fi
    grep -q 'dsh_ish_verify: verdict=refused' "$TAMPER" \
        || { echo "   FAIL: no structured refusal record" >&2; exit 1; }
    grep -q 'entry=bin/busybox' "$TAMPER" \
        || { echo "   FAIL: the refusal does not name the entry" >&2; exit 1; }
    grep -q 'expected=sha256=' "$TAMPER" \
        || { echo "   FAIL: the refusal carries no expected digest" >&2; exit 1; }
    cp -p "$ART/busybox.pristine" "$STAGED/bin/busybox"
    echo "   tamper refused: $(grep 'dsh_ish_verify: verdict=refused' "$TAMPER" | head -1)"
fi

echo "== 3/5 C gate: the seam itself =="
DSH_ISH_GATE="$ART/c-smoke.jsonl"
runtime/spike/build/ish/ish-smoke --rootfs "$ROOTFS" --workspace "$WORKSPACE" \
    --workdir /mnt/workspace --timeout 30000 \
    -c 'uname -m' -c 'printf "c-gate\n" > c-gate.txt; cat c-gate.txt' > "$DSH_ISH_GATE"
grep -q '"exitCode":0' "$DSH_ISH_GATE"
grep -q '"stdout":"aarch64' "$DSH_ISH_GATE"
echo "   c-smoke: $(wc -l < "$DSH_ISH_GATE" | tr -d ' ') commands, exit 0"

echo "== 4/5 JS gate: scenario → plugin → gateway → guest =="
LOG="$ART/logs.txt"
rm -f "$LOG"
# DSH_ISH_ROOTFS is the host granting the guest root (no root, no tool: the
# plugin declines to register `ish` and says so); DSH_SPIKE_TMPDIR pins the
# workspace so the deliverable below is a known path.
(cd runtime/spike && \
    DSH_ISH_ROOTFS="$ROOTFS" DSH_SPIKE_TMPDIR="$WORKSPACE" \
    ./build/dsh-spike-cli . scenario/userland-shell.js > "$LOG" 2>&1) || true
grep '^dsh.spike.log:' "$LOG" > "$ART/scenario.jsonl" || true
node test/e2e/check.mjs --manifest test/e2e/scenarios/userland-shell-local.json \
    --log "$LOG" --out "$ART/verdict-userland-shell-local.json"

echo "== 5/5 deliverables =="
printf '%s\n' "$EXPECTED_TEXT" > "$ART/expected-deliverable.txt"
if [ ! -f "$WORKSPACE/$DELIVERABLE" ]; then
    echo "   FAIL: the guest wrote no $DELIVERABLE into the workspace" >&2
    exit 1
fi
if ! cmp -s "$ART/expected-deliverable.txt" "$WORKSPACE/$DELIVERABLE"; then
    echo "   FAIL: $DELIVERABLE does not match the expected bytes" >&2
    diff "$ART/expected-deliverable.txt" "$WORKSPACE/$DELIVERABLE" || true
    exit 1
fi
# The digest the JS layer logged has to be the digest of the file on disk.
DIGEST=$(shasum -a 256 "$WORKSPACE/$DELIVERABLE" | cut -d' ' -f1)
grep -q "\"sha256\":\"$DIGEST\"" "$ART/scenario.jsonl" || {
    echo "   FAIL: the JS layer logged a different digest than the workspace file ($DIGEST)" >&2
    exit 1
}
echo "   deliverable: $DELIVERABLE ($DIGEST) — guest write, JS read-back and disk agree"

cat > "$ART/receipt.json" <<EOF
{
 "host": "macOS $(uname -m) (the desktop CLI, no simulator)",
 "engine": "iSH-arm64 (userspace AArch64 emulator, threaded-code interpreter)",
 "engineVersion": "OpenMinis/ish-arm64 e1d579480fba88e8f0428e3cf23811bcdd05421f, vendored + sha256-pinned by runtime/spike/vendor/ensure-ish.sh",
 "guestRoot": "Alpine 3.21.8 aarch64 minirootfs (sha256 $ROOTFS_SHA256)",
 "phase": "contract v1.3.0 \`ishRun\` — a real Linux userland running INSIDE the host process (no child process, no second OS), driven from the JS layer through system-plugins/dsh-shell-ish",
 "launchConfiguration": "(cd runtime/spike) ./build/dsh-spike-cli . scenario/userland-shell.js, with DSH_ISH_ROOTFS set to the extracted guest root and DSH_SPIKE_TMPDIR pinned to the staged workspace",
 "scenarios": [
  {
   "id": "userland.shell",
   "checker": "test/e2e/scenarios/userland-shell-local.json",
   "result": "pass",
   "note": "11 records, one-to-one: guest identity (uname/alpine-release/id), a pipeline, a separated stderr stream with exit 7, a file the guest wrote and the JS layer read back, a hung command killed by the deadline, and a command after the kill"
  }
 ],
 "deliverables": [
  "$DELIVERABLE — written by the guest into the mounted workspace, read back through the gateway by the scenario, and byte-compared here"
 ],
 "notes": "Two gates: ish-smoke (C, no JS) then the scenario (JS). The logs matching is the checker's verdict; the deliverable is the independent fact beside it."
}
EOF

echo "run-ish-local: PASS — evidence in $ART"
