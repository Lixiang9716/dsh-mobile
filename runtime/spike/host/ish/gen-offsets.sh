#!/bin/sh
# Generate cpu-offsets.h — the struct offsets the hand-written aarch64 gadgets
# read out of cpu_state / fiber_frame / tlb.
#
# The technique is upstream's (tools/staticdefine.sh, with credit to the Linux
# kernel's kbuild.h): asbestos/offsets.c contains a function whose body is only
# `OFFSET(...)`/`MACRO(...)` statements, each of which emits an `.ascii` line via
# inline asm. Compiling it to assembly and rewriting those lines into #defines
# gives the assembler the same numbers the C compiler computed — offsets can
# never drift from the structs.
#
# Usage: gen-offsets.sh <cc> <output.h> <vendor-src> <generated-dir>
#
# One difference from upstream's driver: it reads the compile flags out of
# meson's compile_commands.json for asbestos/asbestos.c. Here the flags are
# passed explicitly, so this works under any build system (and offsets.c needs
# no flags beyond the include root and the configuration defines).
set -e
CC="$1"; OUT="$2"; SRC="$3"; GEN="${4:-}"

[ -n "$CC" ] && [ -n "$OUT" ] && [ -n "$SRC" ] || {
    echo "usage: gen-offsets.sh <cc> <output.h> <vendor-src> [generated-dir]" >&2
    exit 2
}

mkdir -p "$(dirname "$OUT")"
TMP="${OUT}.tmp"

"$CC" -I"$SRC" ${GEN:+-I"$GEN"} \
    -DGUEST_ARM64=1 -DENGINE_ASBESTOS=1 -DLOG_HANDLER_DPRINTF=1 \
    -include "$SRC/tools/staticdefine.h" \
    -S -o - "$SRC/asbestos/offsets.c" | \
sed -ne 's:^[[:space:]]*\.ascii[[:space:]]*"\(.*\)".*:\1:;
         /^->/{s:->#\(.*\):/* \1 */:;
         s:^->\([^ ]*\) [\$$#]*\([^ ]*\) \(.*\):#define \1 \2 /* \3 */:;
         s:->::; p;}' > "$TMP"

# A generator that silently produces an empty header would show up as "the
# assembler read offsets as 0" — thousands of lines away from here.
grep -q '^#define CPU_pc ' "$TMP" || {
    echo "gen-offsets: no CPU_pc in the generated header — the preprocessor produced nothing" >&2
    exit 1
}
mv "$TMP" "$OUT"
