# DSH runtime — Android native layer. Compiles the platform-neutral rt
# host plus the vendored quickjs-ng engine (untracked tree, materialized by
# runtime/dsh/vendor/ensure.sh — wired into the Gradle build as
# ensureDshVendor, which must run before this CMake project).
cmake_minimum_required(VERSION 3.22)
project(dsh_runtime_android C)

set(DSH_RUNTIME_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../runtime/dsh)
set(DSH_ENGINE_DIR ${DSH_RUNTIME_DIR}/vendor/quickjs-ng/0.17.0)
set(DSH_ZSTD_DIR ${DSH_RUNTIME_DIR}/vendor/zstd/1.5.7)
set(DSH_WASM3_DIR ${DSH_RUNTIME_DIR}/vendor/wasm3/0.9.0/source)

add_library(dsh_runtime SHARED
        dsh_jni_scenario.c
        dsh_jni_binding.c
        dsh_gateway_smoke.c
        android_compat.c
        ${DSH_RUNTIME_DIR}/host/dsh_runtime_host.c
        # dsh_socket.c — the loopback socket seam's pump table (contract
        # v1.8.0): dsh_runtime_host.c references dsh_socket_poll/close_all
        # unconditionally, so leaving it out is a link error, not a
        # negotiation (the gateway still decides what gets SERVED).
        ${DSH_RUNTIME_DIR}/host/dsh_socket.c
        # dsh_wasm.c — the WebAssembly seam (contract v1.2.0 wasmRun), served
        # to the gateway by the Kotlin WasmPrimitive: the module is interpreted
        # IN-PROCESS by wasm3 (no JIT, no child process — D2), the same engine
        # and the same 11 TUs the iOS app and the portable spine compile.
        # Pinned by runtime/dsh/vendor/ensure-wasm3.sh, materialized by the
        # same ensureDshVendor Gradle task as the quickjs tree. Until this
        # landed (#335 B4) the release seat answered every shell run with a
        # gateway denial — the shell tool could not execute even its own
        # starter echo.wasm.
        ${DSH_RUNTIME_DIR}/host/dsh_wasm.c
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
        ${DSH_ENGINE_DIR}/dtoa.c
        ${DSH_ENGINE_DIR}/libregexp.c
        ${DSH_ENGINE_DIR}/libunicode.c
        ${DSH_ENGINE_DIR}/quickjs.c
        # zstd 1.5.7 (BSD-3, single-thread) — the host's node:zlib intrinsics
        # link against it; pinned by runtime/dsh/vendor/ensure-zstd.sh
        # (materialized by the same ensureDshVendor Gradle task).
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

target_include_directories(dsh_runtime PRIVATE
        ${DSH_RUNTIME_DIR}/host
        ${DSH_ENGINE_DIR}
        ${DSH_WASM3_DIR}
        ${DSH_ZSTD_DIR}
        ${DSH_ZSTD_DIR}/common)

# zstd's x86_64 fast loop lives in huf_decompress_amd64.S, which the pin does
# NOT carry (vendored subset is .c only): on an x86_64 ABI (the e2e emulator)
# the asm dispatch references undefined HUF_*_fast_asm_loop symbols at link
# time (measured: android-e2e ld.lld, run 35888734956). ZSTD_DISABLE_ASM is
# zstd's own switch (common/portability_macros.h) — every arch stays on the
# portable C fast loop.
target_compile_definitions(dsh_runtime PRIVATE ZSTD_DISABLE_ASM=1)

# -include android_compat.h restores the arc4random_buf declaration for the
# minSdk-26 bionic headers (see android_compat.h); it is a no-op elsewhere.
target_compile_options(dsh_runtime PRIVATE
        -std=c11
        -Wall
        -include ${CMAKE_CURRENT_SOURCE_DIR}/android_compat.h)

target_link_libraries(dsh_runtime log m)
