# CMakeLists.txt — the dsh-mobile M1 spike native library for HarmonyOS.
#
# Compiles the platform-neutral spike host plus the pinned quickjs-ng
# sources through hvigor's externalNativeOptions (clang / OHOS NDK), exactly
# the compile set the desktop proof run uses
# (runtime/spike/host/build.sh): dtoa.c libregexp.c libunicode.c quickjs.c.
# quickjs-libc is deliberately excluded — the spike host provides its own
# minimal glue (runtime/spike/README.md, "Embedding contract").
cmake_minimum_required(VERSION 3.5.0)
project(dsh_spike)

set(SPIKE_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../runtime/spike)
set(QJS_DIR ${SPIKE_ROOT}/vendor/quickjs-ng/0.17.0)

# Materialize the pinned, sha256-verified engine sources before compiling.
# Idempotent: exits 0 in place when the tree is already present; network is
# only touched on the very first fetch. The vendor tree stays untracked
# (upstream discipline D6) — every build environment re-materializes it.
execute_process(
  COMMAND sh ensure.sh
  WORKING_DIRECTORY ${SPIKE_ROOT}/vendor
  RESULT_VARIABLE DSH_ENSURE_RESULT
  OUTPUT_VARIABLE DSH_ENSURE_OUT
  ERROR_VARIABLE DSH_ENSURE_ERR
)
if(NOT DSH_ENSURE_RESULT EQUAL 0)
  message(FATAL_ERROR
    "runtime/spike/vendor/ensure.sh failed (exit ${DSH_ENSURE_RESULT}):\n"
    "${DSH_ENSURE_OUT}${DSH_ENSURE_ERR}")
endif()
message(STATUS "dsh spike: ${DSH_ENSURE_OUT}${DSH_ENSURE_ERR}")

add_library(spike SHARED
  napi_init.cpp
  ${SPIKE_ROOT}/host/dsh_spike_host.c
  ${QJS_DIR}/dtoa.c
  ${QJS_DIR}/libregexp.c
  ${QJS_DIR}/libunicode.c
  ${QJS_DIR}/quickjs.c
)

target_include_directories(spike PRIVATE
  ${SPIKE_ROOT}/host
  ${QJS_DIR}
)

# Mirror the desktop proof-build flags (runtime/spike/host/build.sh):
# C11, -O1, _GNU_SOURCE. Warnings from the upstream engine sources are not
# this repo's to fix (D6) — silence only the noisy generic ones.
set_target_properties(spike PROPERTIES
  C_STANDARD 11
  C_STANDARD_REQUIRED ON
  CXX_STANDARD 17
)
target_compile_definitions(spike PRIVATE _GNU_SOURCE)
target_compile_options(spike PRIVATE
  -O1
  -Wno-unused-parameter
  -Wno-unused-function
)

# The OHOS musl declares getentropy in <unistd.h> (glibc/macOS: <stdlib.h>);
# force-include it for the platform-neutral host instead of editing upstream.
set_source_files_properties(${SPIKE_ROOT}/host/dsh_spike_host.c PROPERTIES
  COMPILE_OPTIONS "-include;unistd.h"
)

target_link_libraries(spike PUBLIC libace_napi.z.so libhilog_ndk.z.so)
