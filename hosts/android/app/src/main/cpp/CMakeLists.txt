# DSH M1 spike — Android native layer. Compiles the platform-neutral spike
# host plus the vendored quickjs-ng engine (untracked tree, materialized by
# runtime/spike/vendor/ensure.sh — wired into the Gradle build as
# ensureSpikeVendor, which must run before this CMake project).
cmake_minimum_required(VERSION 3.22)
project(dsh_spike_android C)

set(DSH_SPIKE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../runtime/spike)
set(DSH_ENGINE_DIR ${DSH_SPIKE_DIR}/vendor/quickjs-ng/0.17.0)

add_library(dsh_spike SHARED
        dsh_spike_jni.c
        dsh_spike_smoke.c
        android_compat.c
        ${DSH_SPIKE_DIR}/host/dsh_spike_host.c
        ${DSH_ENGINE_DIR}/dtoa.c
        ${DSH_ENGINE_DIR}/libregexp.c
        ${DSH_ENGINE_DIR}/libunicode.c
        ${DSH_ENGINE_DIR}/quickjs.c)

target_include_directories(dsh_spike PRIVATE
        ${DSH_SPIKE_DIR}/host
        ${DSH_ENGINE_DIR})

# -include android_compat.h restores the arc4random_buf declaration for the
# minSdk-26 bionic headers (see android_compat.h); it is a no-op elsewhere.
target_compile_options(dsh_spike PRIVATE
        -std=c11
        -Wall
        -include ${CMAKE_CURRENT_SOURCE_DIR}/android_compat.h)

target_link_libraries(dsh_spike log m)
