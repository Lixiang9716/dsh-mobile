# Vendor.cmake — configure-time pin materialization for the CMake layer.
#
# The vendored trees under runtime/dsh/vendor/ are UNTRACKED by design
# (upstream discipline D6): every build environment re-materializes them from
# the pins, and each ensure script verifies what lands on disk against a
# sha256 before writing the pin stamp. The root CMakeLists.txt includes this
# module BEFORE add_subdirectory(runtime/dsh/host) for exactly that reason —
# the core's source list references files only the ensure scripts guarantee.
#
# One entry point per concern (the scripts chain internally, same as the
# harmony cpp/CMakeLists runs only ensure.sh):
#   runtime/dsh/vendor/ensure.sh      — the engines: quickjs-ng fork + wasm3
#                                         + zstd (delegates to ensure-wasm3.sh
#                                         and ensure-zstd.sh itself)
#   runtime/dsh/vendor/ensure-dsh.sh  — the pinned upstream DSH JS closure;
#                                         not needed to compile dsh-core, but
#                                         CI/dev expect the pins present
# The iSH ensures (ensure-ish.sh / ensure-ish-rootfs.sh) are deliberately NOT
# run here: the in-process Linux userland is built by its own CMake project
# (runtime/dsh/host/ish), whose callers run vendor/ensure-ish.sh themselves
# (host/build.sh, the iOS app build pre-phase).

option(DSH_SKIP_VENDOR
  "Skip vendor materialization — only when you KNOW the pinned trees are already on disk"
  OFF)
if(DSH_SKIP_VENDOR)
  message(STATUS
    "dsh vendor: DSH_SKIP_VENDOR=ON — SKIPPING pin materialization. If "
    "runtime/dsh/vendor is stale or absent the dsh-core build fails on "
    "missing engine sources; nothing in this module re-verifies the pins.")
  return()
endif()

# _dsh_vendor_tail <text> <keep> <out-var> — the LAST <keep> lines of <text>.
# A first materialization logs pages of fetch progress; when it fails, the
# diagnosis lives at the end, so the FATAL_ERROR carries the tail, not the
# whole transcript.
function(_dsh_vendor_tail text keep out_var)
  string(REPLACE "\n" ";" lines "${text}")
  list(REMOVE_ITEM lines "")
  list(LENGTH lines len)
  if(len EQUAL 0)
    set(${out_var} "(no output captured)" PARENT_SCOPE)
    return()
  endif()
  math(EXPR start "${len} - ${keep}")
  if(start LESS 0)
    set(start 0)
  endif()
  math(EXPR count "${len} - ${start}")
  list(SUBLIST lines ${start} ${count} tail)
  list(JOIN tail "\n" tail_text)
  set(${out_var} "${tail_text}" PARENT_SCOPE)
endfunction()

# include(Vendor) runs in the ROOT's variable scope: CMAKE_CURRENT_SOURCE_DIR
# is the repo root, so the scripts are named by their repo paths. Both scripts
# cd to their own directory internally; the WORKING_DIRECTORY only pins the
# contract for readers.
foreach(DSH_VENDOR_SCRIPT
    runtime/dsh/vendor/ensure.sh
    runtime/dsh/vendor/ensure-dsh.sh)
  execute_process(
    COMMAND sh "${DSH_VENDOR_SCRIPT}"
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    RESULT_VARIABLE DSH_VENDOR_RESULT
    # Naming the same variable for both streams interleaves stdout+stderr in
    # arrival order (execute_process contract) — the transcript the tail shows.
    OUTPUT_VARIABLE DSH_VENDOR_OUT
    ERROR_VARIABLE DSH_VENDOR_OUT)
  if(NOT DSH_VENDOR_RESULT EQUAL 0)
    _dsh_vendor_tail("${DSH_VENDOR_OUT}" 20 DSH_VENDOR_TAIL)
    message(FATAL_ERROR
      "dsh vendor: ${DSH_VENDOR_SCRIPT} failed (exit ${DSH_VENDOR_RESULT}) — "
      "the pinned tree cannot be materialized; last output:\n${DSH_VENDOR_TAIL}")
  endif()
  message(STATUS
    "dsh vendor: ${DSH_VENDOR_SCRIPT} verified — ${DSH_VENDOR_OUT}")
endforeach()
