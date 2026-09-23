# DSH M1 spike — Android native layer. Compiles the platform-neutral spike
# host plus the vendored quickjs-ng engine (untracked tree, materialized by
# runtime/spike/vendor/ensure.sh — wired into the Gradle build as
# ensureSpikeVendor, which must run before this CMake project).
cmake_minimum_required(VERSION 3.22)
project(dsh_spike_android C)

set(DSH_SPIKE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../runtime/spike)
set(DSH_ENGINE_DIR ${DSH_SPIKE_DIR}/vendor/quickjs-ng/0.17.0)
set(DSH_ZSTD_DIR ${DSH_SPIKE_DIR}/vendor/zstd/1.5.7)

add_library(dsh_spike SHARED
        dsh_spike_jni.c
        dsh_spike_m4.c
        dsh_spike_smoke.c
        android_compat.c
        ${DSH_SPIKE_DIR}/host/dsh_spike_host.c
        ${DSH_ENGINE_DIR}/dtoa.c
        ${DSH_ENGINE_DIR}/libregexp.c
        ${DSH_ENGINE_DIR}/libunicode.c
        ${DSH_ENGINE_DIR}/quickjs.c
        # zstd 1.5.7 (BSD-3, single-thread) — the host's node:zlib intrinsics
        # link against it; pinned by runtime/spike/vendor/ensure-zstd.sh
        # (materialized by the same ensureSpikeVendor Gradle task).
        ${DSH_ZSTD_DIR}/common/debug.c
        ${DSH_ZSTD_DIR}/common/entropy_common.c
        ${DSH_ZSTD_DIR}/common/error_private.c
        ${DSH_ZSTD_DIR}/common/fse_decompress.c
        ${DSH_ZSTD_DIR}/common/pool.c
        ${DSH_ZSTD_DIR}/common/threading.c
        ${DSH_ZSTD_DIR}/common/xxhash.c
        ${DSH_ZSTD_DIR}/common/zstd_common.c
        ${DSH_ZSTD_DIR}/compress/fse_compress.c
        ${DSH_ZSTD_DIR}/compress/hist.c
        ${DSH_ZSTD_DIR}/compress/huf_compress.c
        ${DSH_ZSTD_DIR}/compress/zstd_compress.c
        ${DSH_ZSTD_DIR}/compress/zstd_compress_literals.c
        ${DSH_ZSTD_DIR}/compress/zstd_compress_sequences.c
        ${DSH_ZSTD_DIR}/compress/zstd_compress_superblock.c
        ${DSH_ZSTD_DIR}/compress/zstd_double_fast.c
        ${DSH_ZSTD_DIR}/compress/zstd_fast.c
        ${DSH_ZSTD_DIR}/compress/zstd_lazy.c
        ${DSH_ZSTD_DIR}/compress/zstd_ldm.c
        ${DSH_ZSTD_DIR}/compress/zstd_opt.c
        ${DSH_ZSTD_DIR}/compress/zstd_preSplit.c
        ${DSH_ZSTD_DIR}/decompress/huf_decompress.c
        ${DSH_ZSTD_DIR}/decompress/zstd_ddict.c
        ${DSH_ZSTD_DIR}/decompress/zstd_decompress.c
        ${DSH_ZSTD_DIR}/decompress/zstd_decompress_block.c)

target_include_directories(dsh_spike PRIVATE
        ${DSH_SPIKE_DIR}/host
        ${DSH_ENGINE_DIR}
        ${DSH_ZSTD_DIR}
        ${DSH_ZSTD_DIR}/common)

# zstd's x86_64 fast loop lives in huf_decompress_amd64.S, which the pin does
# NOT carry (vendored subset is .c only): on an x86_64 ABI (the e2e emulator)
# the asm dispatch references undefined HUF_*_fast_asm_loop symbols at link
# time (measured: android-e2e ld.lld, run 35888734956). ZSTD_DISABLE_ASM is
# zstd's own switch (common/portability_macros.h) — every arch stays on the
# portable C fast loop.
target_compile_definitions(dsh_spike PRIVATE ZSTD_DISABLE_ASM=1)

# -include android_compat.h restores the arc4random_buf declaration for the
# minSdk-26 bionic headers (see android_compat.h); it is a no-op elsewhere.
target_compile_options(dsh_spike PRIVATE
        -std=c11
        -Wall
        -include ${CMAKE_CURRENT_SOURCE_DIR}/android_compat.h)

target_link_libraries(dsh_spike log m)
