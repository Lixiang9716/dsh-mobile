# cmake/Gates.cmake — the build-system face of the repository's quality gates.
#
# Included from the top-level CMakeLists.txt. include() executes in the
# includer's scope (it does not re-point CMAKE_CURRENT_SOURCE_DIR the way
# add_subdirectory() does), so here CMAKE_CURRENT_SOURCE_DIR is the repo
# root, and enable_testing() below runs at top level — the only scope from
# which CTest sees this suite.
#
# The two tests (and exactly two — see the phase-2 seam at the bottom):
#
#   dsh-gate-closures
#     Wraps `sh build/check-closures.sh` — the `closures` gate declared in
#     gates.json. Byte-verifies that every committed per-host copy of the
#     canonical runtime/spike closure (android assets, harmony rawfile, the
#     ios generated bundle) is identical to its source.
#
#   dsh-gate-gov
#     Wraps `gov run` — the full default gate DAG from gates.json
#     (defaultMode "all"), of which dsh-gate-closures is one gate. Registered
#     only when the gov binary is found: an absent tool must neither fail
#     configure nor appear as a silently-passing test, so absence downgrades
#     to a configure-time STATUS message naming the remedy
#     (uv tool install govrail) and simply leaves the test unregistered.
#
# Ownership: ctest is a second face of the gates, not a replacement. The DAG
# definition (gates.json), the task cards, and the pre-push hooks stay owned
# by govrail; `gov run` remains the canonical invocation. These tests exist
# so `ctest` reaches the same checks from a configured build tree.
#
# Run:
#   ctest --preset macos-dev
#   ctest --test-dir build/cmake-macos-dev -R dsh-gate-closures
#
# Phase-2 seam: the individual gates in gates.json are deliberately NOT
# wrapped as separate ctest tests in phase 1 — the two tests above are the
# whole surface. Per-gate wrapping (with per-gate timeouts mirrored from
# gates.json) is the natural phase-2 extension and should extend, not
# replace, these two test names.

enable_testing()

# dsh-gate-closures: the committed-closure byte check. The script computes
# the repo root from its own location, but the command below (`sh
# build/check-closures.sh`) is a repo-root-relative path, so the working
# directory is pinned to the source root explicitly.
add_test(
    NAME dsh-gate-closures
    COMMAND sh build/check-closures.sh
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
set_tests_properties(dsh-gate-closures PROPERTIES TIMEOUT 1800)

# dsh-gate-gov: the govrail DAG. find_program searches PATH first, with
# ~/.local/bin as an explicit hint — the location `uv tool install govrail`
# places the entry point at.
find_program(GOV_EXEC
    NAMES gov
    PATHS "$ENV{HOME}/.local/bin"
    DOC "govrail CLI (install with: uv tool install govrail)")

if(GOV_EXEC)
    add_test(
        NAME dsh-gate-gov
        COMMAND "${GOV_EXEC}" run
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
    set_tests_properties(dsh-gate-gov PROPERTIES TIMEOUT 3600)
else()
    message(STATUS
        "dsh-gate-gov NOT registered: gov binary not found. "
        "Install govrail to run the gate DAG from ctest: uv tool install govrail. "
        "(dsh-gate-closures is unaffected — it does not need gov.)")
endif()
