# dsh-core — the portable C spine of the runtime (STATIC), the one code CMake
# compiles in the phase-1 layer ("add-the-layer, move-no-paths": canonical
# repo paths, no renames).
#
# The file set is derived from the proven per-host builds of these same
# sources — hosts/android/app/src/main/cpp/CMakeLists.txt,
# hosts/harmony/entry/src/main/cpp/CMakeLists.txt and the C Sources of
# hosts/ios/DSHSpike.xcodeproj/project.pbxproj (the three agree on the engine
# set). Platform-edge TUs stay out: dsh_spike_jni.c / dsh_spike_m4.c /
# dsh_spike_smoke.c / android_compat.c are the Android JNI shell's,
# napi_init.cpp / gateway_smoke.cpp the HarmonyOS NAPI shell's, main_cli.c /
# ish_smoke.c are executables' mains, SpikeBundle.c an iOS-generated app file.
#
# The engine trees under vendor/ are UNTRACKED; the root CMakeLists.txt
# includes cmake/Vendor.cmake (materializing quickjs/wasm3/zstd) BEFORE this
# directory, so the pins exist by the time these sources resolve.
set(DSH_VENDOR_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../vendor")
set(DSH_QJS_DIR "${DSH_VENDOR_DIR}/quickjs-ng/0.17.0")
set(DSH_WASM3_DIR "${DSH_VENDOR_DIR}/wasm3/0.9.0/source")
set(DSH_ZSTD_DIR "${DSH_VENDOR_DIR}/zstd/1.5.7")

add_library(dsh-core STATIC
  # The platform-neutral host + the WebAssembly seam (dsh_wasm.c pulls the
  # wasm3 API below; the android/harmony shells do not compile it, the iOS
  # app does — it is portable C, so the portable spine carries it).
  dsh_spike_host.c
  dsh_wasm.c
  # The quickjs-ng fork (pin: vendor/ensure.sh) — exactly the four TUs every
  # proven build compiles; quickjs-libc is deliberately excluded (the spike
  # host provides its own glue, runtime/spike/README.md "Embedding contract").
  "${DSH_QJS_DIR}/dtoa.c"
  "${DSH_QJS_DIR}/libregexp.c"
  "${DSH_QJS_DIR}/libunicode.c"
  "${DSH_QJS_DIR}/quickjs.c"
  # wasm3 0.9.0 (pin: vendor/ensure-wasm3.sh, chained by ensure.sh) — the
  # full vendored source/ set, the same 11 TUs the iOS project compiles.
  "${DSH_WASM3_DIR}/m3_bind.c"
  "${DSH_WASM3_DIR}/m3_code.c"
  "${DSH_WASM3_DIR}/m3_compile.c"
  "${DSH_WASM3_DIR}/m3_core.c"
  "${DSH_WASM3_DIR}/m3_env.c"
  "${DSH_WASM3_DIR}/m3_exec.c"
  "${DSH_WASM3_DIR}/m3_function.c"
  "${DSH_WASM3_DIR}/m3_info.c"
  "${DSH_WASM3_DIR}/m3_module.c"
  "${DSH_WASM3_DIR}/m3_parse.c"
  "${DSH_WASM3_DIR}/m3_validate.c"
  # zstd 1.5.7 (BSD-3, single-thread — no ZSTD_MULTITHREAD: one serial
  # runtime thread is the constitution, D2), the node:zlib face of the host
  # intrinsics; pin: vendor/ensure-zstd.sh. The .c-only subset, identical in
  # all three per-host builds.
  "${DSH_ZSTD_DIR}/common/debug.c"
  "${DSH_ZSTD_DIR}/common/entropy_common.c"
  "${DSH_ZSTD_DIR}/common/error_private.c"
  "${DSH_ZSTD_DIR}/common/fse_decompress.c"
  "${DSH_ZSTD_DIR}/common/pool.c"
  "${DSH_ZSTD_DIR}/common/threading.c"
  "${DSH_ZSTD_DIR}/common/xxhash.c"
  "${DSH_ZSTD_DIR}/common/zstd_common.c"
  "${DSH_ZSTD_DIR}/compress/fse_compress.c"
  "${DSH_ZSTD_DIR}/compress/hist.c"
  "${DSH_ZSTD_DIR}/compress/huf_compress.c"
  "${DSH_ZSTD_DIR}/compress/zstd_compress.c"
  "${DSH_ZSTD_DIR}/compress/zstd_compress_literals.c"
  "${DSH_ZSTD_DIR}/compress/zstd_compress_sequences.c"
  "${DSH_ZSTD_DIR}/compress/zstd_compress_superblock.c"
  "${DSH_ZSTD_DIR}/compress/zstd_double_fast.c"
  "${DSH_ZSTD_DIR}/compress/zstd_fast.c"
  "${DSH_ZSTD_DIR}/compress/zstd_lazy.c"
  "${DSH_ZSTD_DIR}/compress/zstd_ldm.c"
  "${DSH_ZSTD_DIR}/compress/zstd_opt.c"
  "${DSH_ZSTD_DIR}/compress/zstd_preSplit.c"
  "${DSH_ZSTD_DIR}/decompress/huf_decompress.c"
  "${DSH_ZSTD_DIR}/decompress/zstd_ddict.c"
  "${DSH_ZSTD_DIR}/decompress/zstd_decompress.c"
  "${DSH_ZSTD_DIR}/decompress/zstd_decompress_block.c")

# dsh_ish.c — the in-process Linux emulator bridge (contract v1.3.0 ishRun).
# It compiles clean on Apple clang — but ONLY against the vendored iSH engine
# tree, which cmake/Vendor.cmake deliberately does not materialize (the iSH
# ensures stay owned by the engine's own build, runtime/spike/host/ish, whose
# callers run vendor/ensure-ish.sh themselves). Test-compiled with Apple clang
# on this configuration: plain, it dies on "kernel/calls.h file not found";
# with the engine include dir + the three engine configuration defines below
# it compiles with zero diagnostics. The engine implementation itself stays in
# libishcore.a — a static library records undefined symbols instead of
# resolving them, so consumers link the same -lishcore -lsqlite3 -lz -lresolv
# set host/build.sh and the iOS pre-phase already pass. Skip loudly rather
# than fail when the tree was never fetched: its own build path is the
# contract for that case.
set(DSH_ISH_PIN e1d579480fba88e8f0428e3cf23811bcdd05421f) # host/ish/CMakeLists.txt's ISH_PIN
set(DSH_ISH_SRC "${DSH_VENDOR_DIR}/ish/${DSH_ISH_PIN}")
if(EXISTS "${DSH_ISH_SRC}/kernel/calls.h")
  target_sources(dsh-core PRIVATE dsh_ish.c)
  # Scoped to this one TU: the engine's headers must not see the rest of the
  # spine, and the spine must not see the engine's configuration macros
  # (the triple is host/ish/CMakeLists.txt's add_compile_definitions).
  set_source_files_properties(dsh_ish.c PROPERTIES
    INCLUDE_DIRECTORIES "${DSH_ISH_SRC}"
    COMPILE_DEFINITIONS "GUEST_ARM64=1;ENGINE_ASBESTOS=1;LOG_HANDLER_DPRINTF=1")
else()
  message(STATUS
    "dsh-core: dsh_ish.c LEFT OUT — vendored iSH tree absent at "
    "${DSH_ISH_SRC} (run runtime/spike/vendor/ensure-ish.sh; the engine's own "
    "build, runtime/spike/host/ish, is the contract for this dependency)")
endif()

target_include_directories(dsh-core PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${DSH_QJS_DIR}"
  "${DSH_WASM3_DIR}"
  "${DSH_ZSTD_DIR}"
  "${DSH_ZSTD_DIR}/common")

# ZSTD_DISABLE_ASM=1 — every per-host build passes it: the vendored subset
# carries no huf_decompress_amd64.S, so on x86_64 the asm dispatch would
# reference undefined HUF_*_fast_asm_loop symbols at link time (android
# comment, measured there). zstd's own switch, every arch on the C fast loop.
# _GNU_SOURCE — the harmony list and the desktop proof build
# (runtime/spike/host/build.sh, which runs on macOS) both compile these
# sources with it; the android list does not. Kept: harmless on Darwin, and
# it is what the OHOS musl build needs from this same file set.
target_compile_definitions(dsh-core PRIVATE
  ZSTD_DISABLE_ASM=1
  _GNU_SOURCE)

# -Wall from the android list; -Wno-unused-parameter/-Wno-unused-function
# from the harmony list (upstream engine warnings are not this repo's to fix,
# D6). Warnings are NOT errors here. Not carried: android's
# -include android_compat.h (bionic arc4random_buf, no-op elsewhere by
# construction), harmony's -Wno-unused-command-line-argument (hvigor's
# --gcc-toolchain noise, an OHOS SDK artifact), harmony's -O1 (it mirrors
# build.sh; the iOS project instead optimizes per configuration — the layer
# leaves that to CMAKE_BUILD_TYPE). Harmony's -include unistd.h below is the
# one per-file accommodation kept: the OHOS musl declares getentropy in
# <unistd.h> instead of <stdlib.h>; force-including it is a no-op on Darwin
# and keeps this list byte-equivalent with the proven harmony compile.
target_compile_options(dsh-core PRIVATE
  -Wall
  -Wno-unused-parameter
  -Wno-unused-function)
set_source_files_properties(dsh_spike_host.c PROPERTIES
  COMPILE_OPTIONS "-include;unistd.h")

# Release logging regime (AGENTS.md rule L4): -DDSH_RELEASE=1 on the cache —
# the way entry/build-profile.json5 feeds the harmony build — makes the shared
# host inject globalThis.__DSH_RELEASE__ so the JS logger drops debug/info at
# the source. The status line keeps the regime visible in the configure log.
if(DSH_RELEASE)
  message(STATUS "dsh-core: DSH_RELEASE=1 — release logging regime (warn/error only)")
  target_compile_definitions(dsh-core PRIVATE DSH_RELEASE=1)
else()
  message(STATUS "dsh-core: debug logging regime (full structured logging)")
endif()
