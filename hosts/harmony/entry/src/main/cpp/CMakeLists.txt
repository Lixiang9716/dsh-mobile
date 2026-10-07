# CMakeLists.txt — the dsh-mobile M1 rt native library for HarmonyOS.
#
# Compiles the platform-neutral rt host plus the pinned quickjs-ng
# sources through hvigor's externalNativeOptions (clang / OHOS NDK), exactly
# the compile set the desktop proof run uses
# (runtime/dsh/host/build.sh): dtoa.c libregexp.c libunicode.c quickjs.c.
# quickjs-libc is deliberately excluded — the rt host provides its own
# minimal glue (runtime/dsh/README.md, "Embedding contract").
cmake_minimum_required(VERSION 3.5.0)
project(dsh_druntime)

set(DSH_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../runtime/dsh)
set(QJS_DIR ${DSH_ROOT}/vendor/quickjs-ng/0.17.0)
set(ZSTD_DIR ${DSH_ROOT}/vendor/zstd/1.5.7)

# Materialize the pinned, sha256-verified engine sources before compiling.
# Idempotent: exits 0 in place when the tree is already present; network is
# only touched on the very first fetch. The vendor tree stays untracked
# (upstream discipline D6) — every build environment re-materializes it.
execute_process(
  COMMAND sh ensure.sh
  WORKING_DIRECTORY ${DSH_ROOT}/vendor
  RESULT_VARIABLE DSH_ENSURE_RESULT
  OUTPUT_VARIABLE DSH_ENSURE_OUT
  ERROR_VARIABLE DSH_ENSURE_ERR
)
if(NOT DSH_ENSURE_RESULT EQUAL 0)
  message(FATAL_ERROR
    "runtime/dsh/vendor/ensure.sh failed (exit ${DSH_ENSURE_RESULT}):\n"
    "${DSH_ENSURE_OUT}${DSH_ENSURE_ERR}")
endif()
message(STATUS "dsh rt: ${DSH_ENSURE_OUT}${DSH_ENSURE_ERR}")

add_library(druntime SHARED
  napi_init.cpp
  gateway_smoke.cpp
  ${DSH_ROOT}/host/dsh_runtime_host.c
  # dsh_socket.c — the loopback socket seam's pump table (contract v1.8.0):
  # dsh_runtime_host.c references dsh_socket_poll/close_all unconditionally,
  # so leaving it out is a link error, not a negotiation (the gateway still
  # decides what gets SERVED).
  ${DSH_ROOT}/host/dsh_socket.c
  ${QJS_DIR}/dtoa.c
  ${QJS_DIR}/libregexp.c
  ${QJS_DIR}/libunicode.c
  ${QJS_DIR}/quickjs.c
  # zstd 1.5.7 — the host node:zlib intrinsics; pinned by vendor/ensure-zstd.sh
  ${ZSTD_DIR}/common/debug.c
  ${ZSTD_DIR}/common/entropy_common.c
  ${ZSTD_DIR}/common/error_private.c
  ${ZSTD_DIR}/common/fse_decompress.c
  ${ZSTD_DIR}/common/pool.c
  ${ZSTD_DIR}/common/threading.c
  ${ZSTD_DIR}/common/xxhash.c
  ${ZSTD_DIR}/common/zstd_common.c
  ${ZSTD_DIR}/compress/fse_compress.c
  ${ZSTD_DIR}/compress/hist.c
  ${ZSTD_DIR}/compress/huf_compress.c
  ${ZSTD_DIR}/compress/zstd_compress.c
  ${ZSTD_DIR}/compress/zstd_compress_literals.c
  ${ZSTD_DIR}/compress/zstd_compress_sequences.c
  ${ZSTD_DIR}/compress/zstd_compress_superblock.c
  ${ZSTD_DIR}/compress/zstd_double_fast.c
  ${ZSTD_DIR}/compress/zstd_fast.c
  ${ZSTD_DIR}/compress/zstd_lazy.c
  ${ZSTD_DIR}/compress/zstd_ldm.c
  ${ZSTD_DIR}/compress/zstd_opt.c
  ${ZSTD_DIR}/compress/zstd_preSplit.c
  ${ZSTD_DIR}/decompress/huf_decompress.c
  ${ZSTD_DIR}/decompress/zstd_ddict.c
  ${ZSTD_DIR}/decompress/zstd_decompress.c
  ${ZSTD_DIR}/decompress/zstd_decompress_block.c
)

target_include_directories(druntime PRIVATE
  ${DSH_ROOT}/host
  ${QJS_DIR}
  ${ZSTD_DIR}
  ${ZSTD_DIR}/common
)

# Same as the android/CLI builds: the vendored zstd subset carries no
# huf_decompress_amd64.S, so the x86_64 BMI2 asm dispatch is compiled out —
# ZSTD_DISABLE_ASM (zstd's own switch) keeps every arch on the C fast loop.
target_compile_definitions(druntime PRIVATE ZSTD_DISABLE_ASM=1)

# Mirror the desktop proof-build flags (runtime/dsh/host/build.sh):
# C11, -O1, _GNU_SOURCE. Warnings from the upstream engine sources are not
# this repo's to fix (D6) — silence only the noisy generic ones.
set_target_properties(druntime PROPERTIES
  C_STANDARD 11
  C_STANDARD_REQUIRED ON
  CXX_STANDARD 17
)
target_compile_definitions(druntime PRIVATE _GNU_SOURCE)

# Release logging regime. entry/build-profile.json5's release buildOptionSet
# passes -DDSH_RELEASE=1 as a CMake cache variable (cppFlags maps to
# CMAKE_CXX_FLAGS only and would miss the C host), and this turns it into a
# compile definition for the WHOLE target — C host included — so the shared
# host's dsh_bind_globals() injects globalThis.__DSH_RELEASE__ and the JS
# logger drops debug/info at the source. The status line makes the regime
# visible in the build log, so the flag is never silently absent.
if(DSH_RELEASE)
  message(STATUS "dsh rt: DSH_RELEASE=1 — release logging regime (warn/error only)")
  target_compile_definitions(druntime PRIVATE DSH_RELEASE=1)
else()
  message(STATUS "dsh rt: debug logging regime (full structured logging)")
endif()

target_compile_options(druntime PRIVATE
  -O1
  -Wno-unused-parameter
  -Wno-unused-function
  # hvigor's toolchain passes --gcc-toolchain=<its own llvm dir> on every
  # clang invocation; clang flags it [-Wunused-command-line-argument] on all
  # ~32 of this target's TUs (measured: 32 warnings a build on CI). The
  # argument IS harmless (the toolchain dir is the one in use), so silence
  # the diagnostic rather than fight the SDK.
  -Wno-unused-command-line-argument
)

# The OHOS musl declares getentropy in <unistd.h> (glibc/macOS: <stdlib.h>);
# force-include it for the platform-neutral host instead of editing upstream.
set_source_files_properties(${DSH_ROOT}/host/dsh_runtime_host.c PROPERTIES
  COMPILE_OPTIONS "-include;unistd.h"
)

target_link_libraries(druntime PUBLIC libace_napi.z.so libhilog_ndk.z.so)
