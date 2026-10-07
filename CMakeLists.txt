# The top-level CMake layer — phase 1: add-the-layer, move-no-paths.
#
# Scope (the 2026-09-27 owner direction: a cross-platform build graph with a
# single entry, without renaming any existing directory):
#   - the C CORE is the only code CMake compiles: target dsh-core (static lib)
#     from runtime/dsh/host + the pinned engines in runtime/dsh/vendor
#     (the same file sets the android/harmony cpp/CMakeLists already compile);
#   - the three app shells stay owned by their platform toolchains (xcodebuild,
#     Gradle, hvigor) — dsh-ios/dsh-android/dsh-harmony are wrapper targets
#     delegating to build/build.sh, NOT CMake-compiled apps;
#   - the gates ride CTest so `ctest` reaches the same checks `gov run` runs.
#
# Directory semantics (aliases, not renames — the repo paths are canonical):
#   src/      → runtime/dsh/host        external/ → runtime/dsh/vendor
#   test/     → test/ + the gov gates     doc/      → docs/
cmake_minimum_required(VERSION 3.21)
project(dsh-mobile LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

# Configure-time pin materialization MUST precede add_subdirectory(runtime/
# dsh/host): the core's source list references files only the ensure
# scripts guarantee. Fail loud when a pin cannot be materialized (rule 5).
include(Vendor)

add_subdirectory(runtime/dsh/host)

# Wrapper targets for the three platform shells (delegate to build/build.sh).
include(Apps)

# The gates as CTest tests (dsh-gate-*) — `ctest` is the build-system face of
# `gov run`'s DAG; the DAG itself stays owned by govrail.
include(Gates)
