# cmake/Apps.cmake — the platform-shell wrapper targets (phase 1:
# add-the-layer, move-no-paths).
#
# The three app shells stay owned by their platform toolchains (xcodebuild /
# Gradle / hvigor); CMake is the unified ENTRY, not their compiler. Every
# target below is a thin delegation to build/build.sh — the shell script stays
# the single source of what sync/compile/test mean (BUILD.md); nothing here
# re-implements build.sh's steps. In a later phase the sync/stage steps become
# first-class custom commands with real dependency edges on their inputs;
# today the ordering is target-level only.
#
# The `test`/`check` verbs are deliberately NOT wrapped: the gates already
# ride CTest through Gates.cmake (dsh-gate-*) — a build.sh test/check wrapper
# here would duplicate `gov run`'s DAG under a second driver.
#
# Preset/target cheat-sheet:
#   cmake --preset macos-dev
#   cmake --build --preset macos-dev --target dsh-android
#   ctest --preset macos-dev
#
# WORKING_DIRECTORY is pinned to the repo root because the COMMAND names
# build/build.sh relative to it; Apps.cmake is include()d from the root
# CMakeLists.txt, and include() runs in the caller's scope, so
# CMAKE_CURRENT_SOURCE_DIR there IS the repo root. (build.sh itself also
# re-derives its ROOT from $0, so the pin is about resolving the relative
# script path.) USES_TERMINAL routes the commands through ninja's console
# pool so build.sh's streaming output stays interactive. Each dsh-<platform>
# target depends on its dsh-sync-<platform> so the DAG orders the closure
# re-stage before the shell build; build.sh's `build` verb re-runs the sync
# internally anyway (stage_sync precedes stage_compile), so the doubled sync
# is idempotent restaging — accepted phase-1 duplication.

set(DSH_APP_PLATFORMS ios android harmony)

foreach(_p IN LISTS DSH_APP_PLATFORMS)
  add_custom_target(dsh-sync-${_p}
    COMMAND sh build/build.sh sync ${_p}
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    VERBATIM
    USES_TERMINAL
    COMMENT "sync ${_p}: build/build.sh sync ${_p}")

  add_custom_target(dsh-${_p}
    COMMAND sh build/build.sh build ${_p}
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    VERBATIM
    USES_TERMINAL
    COMMENT "build ${_p}: build/build.sh build ${_p} (sync + compile + test)")

  add_dependencies(dsh-${_p} dsh-sync-${_p})
endforeach()

unset(_p)

# The core has no app shell: the dsh-core static lib is defined by
# runtime/dsh/host (see root CMakeLists.txt), so only its closure re-stage
# is a wrapper here.
add_custom_target(dsh-sync-core
  COMMAND sh build/build.sh sync core
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
  VERBATIM
  USES_TERMINAL
  COMMENT "sync core: build/build.sh sync core")
