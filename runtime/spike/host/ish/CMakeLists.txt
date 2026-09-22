# dsh-mobile · the vendored iSH-arm64 core, built by CMake
#
# The ONE build tool for this dependency, on every target it has:
#
#   macOS (arm64)   cmake -S runtime/spike/host/ish -B build/ish \
#                         -DISH_VENDOR=<repo>/runtime/spike/vendor
#                   → libishcore.a libdsh_ish.a + the ish-smoke executable
#   iOS             cmake … -DCMAKE_TOOLCHAIN_FILE=runtime/spike/host/ish/ios.cmake \
#                         -DISH_SDK=iphonesimulator|iphoneos
#                   → the same two static libraries, linked by DSHSpike.xcodeproj
#
# Upstream ships a meson build for this tree. We do not use it: meson is not on
# the CI images and the iOS app target would need a meson+ninja pre-phase beside
# Xcode's own build. This file is a transcription of upstream's `meson.build`
# source lists and flags for the configuration we vendor — `guest_arch=arm64`,
# `kernel=ish`, `engine=asbestos` — so the two builds compile the same files
# with the same defines. Where they differ it is called out inline.
#
# Sources are listed explicitly rather than globbed: upstream's list IS the
# record of which files belong to the arm64/ish/asbestos configuration (the
# tree also contains the i386 guest backend and the fork's "real Linux kernel"
# mode, neither of which may be compiled here).
cmake_minimum_required(VERSION 3.20)
project(dsh_ish C ASM)

set(ISH_PIN e1d579480fba88e8f0428e3cf23811bcdd05421f CACHE STRING "vendored iSH-arm64 commit")
set(ISH_VENDOR "${CMAKE_CURRENT_SOURCE_DIR}/../../vendor" CACHE PATH
    "runtime/spike/vendor directory (written by vendor/ensure-ish.sh)")
set(ISH_SRC "${ISH_VENDOR}/ish/${ISH_PIN}")

if(NOT ISH_SRC MATCHES "ish/${ISH_PIN}$" OR NOT EXISTS "${ISH_SRC}/kernel/init.c")
  message(FATAL_ERROR
    "vendored iSH-arm64 sources not found at ${ISH_SRC} — run runtime/spike/vendor/ensure-ish.sh first")
endif()

set(GEN "${CMAKE_CURRENT_BINARY_DIR}/generated")
file(MAKE_DIRECTORY "${GEN}")

# ---------------------------------------------------------------- configuration
# `GUEST_ARM64` selects the aarch64 guest backend; `ENGINE_ASBESTOS` the
# threaded-code interpreter; `LOG_HANDLER_DPRINTF` the log sink upstream's
# debug.h defaults to. One deliberate difference from the meson build: the
# guest-arch and engine macros are constants here, because this build exists for
# exactly one configuration, and a wrong -D must fail the build rather than
# silently compile the other backend.
add_compile_definitions(GUEST_ARM64=1 ENGINE_ASBESTOS=1 LOG_HANDLER_DPRINTF=1)
# -Wtautological-constant-in-range-compare is clang-only (upstream's meson
# build assumes clang); gcc errors out on it, and this CMake project also
# carries the Linux build (host/build.sh's "macOS/Linux proof run"), so the
# flag rides only where the compiler knows it.
add_compile_options(-Wno-switch -Wimplicit-fallthrough)
if(CMAKE_C_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wtautological-constant-in-range-compare)
endif()

if(APPLE)
  # CMAKE_SYSTEM_NAME is "iOS" when the iOS toolchain file is in use; upstream's
  # platform split is by host OS, and both Apple platforms take platform/darwin.c.
  set(ISH_PLATFORM_SRC "${ISH_SRC}/platform/darwin.c")
else()
  set(ISH_PLATFORM_SRC "${ISH_SRC}/platform/linux.c")
endif()

# ------------------------------------------------------------------- cpu-offsets
# The aarch64 gadgets are hand-written assembly and reach the C structs through
# `cpu-offsets.h`, which is PREPROCESSED OUT of asbestos/offsets.c: the file's
# assembly bodies emit each offset as an `.ascii` line, and the sed pass turns
# those into #defines (the same trick as the Linux kernel's kbuild.h). Upstream
# drives it from meson's compile_commands.json; passing the flags explicitly is
# the only change, so the generator does not depend on a build-system artifact.
set(ISH_OFFSETS_H "${GEN}/cpu-offsets.h")
add_custom_command(
  OUTPUT "${ISH_OFFSETS_H}"
  COMMAND sh "${CMAKE_CURRENT_SOURCE_DIR}/gen-offsets.sh"
          "${CMAKE_C_COMPILER}" "${ISH_OFFSETS_H}"
          "${ISH_SRC}" "${GEN}"
  DEPENDS "${ISH_SRC}/asbestos/offsets.c" "${CMAKE_CURRENT_SOURCE_DIR}/gen-offsets.sh"
  COMMENT "Generating cpu-offsets.h from asbestos/offsets.c"
  VERBATIM)

# ---------------------------------------------------------------------- the vdso
# The vdso is a real aarch64 ELF that the kernel maps into every guest process,
# so it cannot be built with the host toolchain: it needs a clang that can target
# aarch64-linux-gnu (Homebrew LLVM ships one; Apple's clang has no ELF linker).
# Without it upstream ships a placeholder and says so — we do the same, loudly,
# because a stub vdso is a guest-visible capability difference, not a silent one.
# It is worse than "no vdso", though: a zeroed vdso_data makes vdso_symbol()
# take kernel/vdso.c's fail path, which ABORTS the host on the first signal
# delivered to a guest task with a handler (kernel/signal.c's
# sigreturn_trampoline). So a build that cannot cross-compile the elf must
# REUSE one that could — the elf is a GUEST aarch64 ELF, mapped into the guest
# address space, so it is host-architecture independent and identical across
# platforms: the iOS cross-compile (the same problem twice) points
# ISH_VDSO_ELF_DIR at the directory a HOST configure built it in.
set(ISH_VDSO_DIR "${CMAKE_CURRENT_BINARY_DIR}/vdso")
file(MAKE_DIRECTORY "${ISH_VDSO_DIR}")
set(ISH_VDSO_ELF "${ISH_VDSO_DIR}/libvdso.so.elf")
set(ISH_VDSO_ELF_DIR "" CACHE PATH
    "directory holding a prebuilt libvdso.so.elf to use instead of building one")
if(ISH_VDSO_ELF_DIR)
  set(ISH_VDSO_DIR "${ISH_VDSO_ELF_DIR}")
  file(MAKE_DIRECTORY "${ISH_VDSO_DIR}")
  set(ISH_VDSO_ELF "${ISH_VDSO_DIR}/libvdso.so.elf")
endif()
set(ISH_VDSO_CLANG "" CACHE FILEPATH "clang with an aarch64-linux-gnu target (empty = search)")
if(NOT ISH_VDSO_CLANG)
  foreach(cand /opt/homebrew/opt/llvm/bin/clang /usr/local/opt/llvm/bin/clang)
    if(EXISTS "${cand}")
      set(ISH_VDSO_CLANG "${cand}")
      break()
    endif()
  endforeach()
endif()
if(NOT ISH_VDSO_CLANG)
  find_program(ISH_VDSO_CLANG clang)
endif()

set(ISH_SDK "" CACHE STRING "iOS SDK name (iphonesimulator/iphoneos); empty = macOS build")
set(ISH_VDSO_FOUND FALSE)
if(ISH_SDK)
  # Cross-compiling the vdso while cross-compiling the app is the same problem
  # twice; the iOS build takes the elf from a macOS configure (see build-ish.sh).
  set(ISH_VDSO_FOUND FALSE)
elseif(ISH_VDSO_CLANG)
  execute_process(
    COMMAND "${ISH_VDSO_CLANG}" -target aarch64-linux-gnu -fuse-ld=lld
            -nostdlib -shared -o "${ISH_VDSO_DIR}/probe.elf" -xc "${ISH_SRC}/vdso/arm64/vdso.c"
    RESULT_VARIABLE ISH_VDSO_PROBE
    OUTPUT_VARIABLE ISH_VDSO_PROBE_OUT
    ERROR_VARIABLE ISH_VDSO_PROBE_ERR)
  if(ISH_VDSO_PROBE EQUAL 0)
    set(ISH_VDSO_FOUND TRUE)
    message(STATUS "guest vdso cross-compiler: ${ISH_VDSO_CLANG}")
  else()
    message(STATUS "guest vdso cross-compiler probe failed (${ISH_VDSO_PROBE}): ${ISH_VDSO_PROBE_ERR}")
  endif()
endif()

if(ISH_VDSO_ELF_DIR)
  # The prebuilt branch: no rule of its own, but the file must be a REAL elf.
  # An empty one is the placeholder above, which aborts the host on the first
  # guest signal — refuse it here rather than shipping that build.
  if(NOT EXISTS "${ISH_VDSO_ELF}" OR IS_DIRECTORY "${ISH_VDSO_ELF}")
    message(FATAL_ERROR
      "ISH_VDSO_ELF_DIR=${ISH_VDSO_ELF_DIR} holds no libvdso.so.elf — build the "
      "guest vdso once with a HOST configure (cmake -S runtime/spike/host/ish -B "
      "runtime/spike/build/ish) and point this at its vdso/ directory")
  endif()
  file(SIZE "${ISH_VDSO_ELF}" ISH_VDSO_ELF_SIZE)
  if(ISH_VDSO_ELF_SIZE EQUAL 0)
    message(FATAL_ERROR
      "ISH_VDSO_ELF_DIR=${ISH_VDSO_ELF_DIR}/libvdso.so.elf is EMPTY (the "
      "placeholder vdso) — a host configure without an aarch64-linux-gnu clang "
      "cannot produce one; install LLVM (brew install llvm) or point this at a "
      "directory that holds a real elf")
  endif()
  message(STATUS "guest vdso: reusing the prebuilt ${ISH_VDSO_ELF}")
elseif(ISH_VDSO_FOUND)
  # Each -Wl argument is ONE quoted element: quoting a path inside a quoted
  # argument makes CMake emit escaped quotes that lld then reads as part of the
  # filename ("cannot find linker script \"…\"").
  add_custom_command(
    OUTPUT "${ISH_VDSO_ELF}"
    COMMAND "${ISH_VDSO_CLANG}" -target aarch64-linux-gnu -fuse-ld=lld
            -o "${ISH_VDSO_ELF}" "${ISH_SRC}/vdso/arm64/vdso.S" "${ISH_SRC}/vdso/arm64/vdso.c"
            -nostdlib "-Wl,-T,${ISH_SRC}/vdso/arm64/vdso.lds" "-Wl,--hash-style=sysv"
            -shared -fPIC -ffreestanding
    DEPENDS "${ISH_SRC}/vdso/arm64/vdso.S" "${ISH_SRC}/vdso/arm64/vdso.c"
            "${ISH_SRC}/vdso/arm64/vdso.lds"
    COMMENT "Building the guest vdso (aarch64 ELF) with ${ISH_VDSO_CLANG}"
    VERBATIM)
else()
  message(WARNING
    "no clang with an aarch64-linux-gnu target found (ISH_VDSO_CLANG) — "
    "building the placeholder vdso upstream falls back to; the guest gets no vdso")
  add_custom_command(
    OUTPUT "${ISH_VDSO_ELF}"
    COMMAND "${CMAKE_COMMAND}" -E touch "${ISH_VDSO_ELF}"
    COMMENT "Writing the placeholder vdso"
    VERBATIM)
endif()

# A name for the elf alone. The iOS pre-phase builds the guest vdso from a HOST
# configure (the elf is the same on every platform), and going through `ishcore`
# for it would compile the whole engine for what is one clang invocation. Only
# defined where this configure owns a rule for the file — with
# ISH_VDSO_ELF_DIR the elf is an input, not something to build.
if(NOT ISH_VDSO_ELF_DIR)
  add_custom_target(ish-vdso DEPENDS "${ISH_VDSO_ELF}")
endif()

# ------------------------------------------------------------------------ sources
set(ISH_EMU_SRC
  "${ISH_SRC}/emu/tlb.c"
  "${ISH_SRC}/emu/arch/arm64/fpu.c"
  "${ISH_SRC}/asbestos/asbestos.c"
  "${ISH_SRC}/asbestos/guest-arm64/gen.c"
  "${ISH_SRC}/asbestos/guest-arm64/crypto_helpers.c"
  "${ISH_SRC}/asbestos/helpers.c"
  "${ISH_SRC}/kernel/native_offload_sym.c"
  "${ISH_SRC}/kernel/native_offload_sym_builtins.c"
  "${ISH_SRC}/kernel/native_offload_prebuilt.c"
  "${ISH_SRC}/asbestos/guest-arm64/gadgets-aarch64/entry.S"
  "${ISH_SRC}/asbestos/guest-arm64/gadgets-aarch64/memory.S"
  "${ISH_SRC}/asbestos/guest-arm64/gadgets-aarch64/control.S"
  "${ISH_SRC}/asbestos/guest-arm64/gadgets-aarch64/math.S"
  "${ISH_SRC}/asbestos/guest-arm64/gadgets-aarch64/bits.S"
  "${ISH_SRC}/asbestos/guest-arm64/gadgets-aarch64/crypto.S")

set(ISH_FAKEFS_SRC
  "${ISH_SRC}/fs/fake-db.c"
  "${ISH_SRC}/fs/fake-migrate.c"
  "${ISH_SRC}/fs/fake-rebuild.c")

set(ISH_CORE_SRC
  "${ISH_SRC}/kernel/init.c"
  "${ISH_SRC}/kernel/errno.c"
  "${ISH_SRC}/kernel/calls.c"
  "${ISH_SRC}/kernel/arch/arm64/calls.c"
  "${ISH_SRC}/kernel/memory.c"
  "${ISH_SRC}/kernel/user.c"
  "${ISH_SRC}/kernel/vdso.c"
  "${ISH_SRC}/kernel/task.c"
  "${ISH_SRC}/kernel/group.c"
  "${ISH_SRC}/kernel/log.c"
  "${ISH_SRC}/kernel/fork.c"
  "${ISH_SRC}/kernel/exec.c"
  "${ISH_SRC}/kernel/exit.c"
  "${ISH_SRC}/kernel/time.c"
  "${ISH_SRC}/kernel/mmap.c"
  "${ISH_SRC}/kernel/uname.c"
  "${ISH_SRC}/kernel/tls.c"
  "${ISH_SRC}/kernel/futex.c"
  "${ISH_SRC}/kernel/getset.c"
  "${ISH_SRC}/kernel/signal.c"
  "${ISH_SRC}/kernel/resource.c"
  "${ISH_SRC}/kernel/random.c"
  "${ISH_SRC}/kernel/misc.c"
  "${ISH_SRC}/kernel/eventfd.c"
  "${ISH_SRC}/kernel/pidfd.c"
  "${ISH_SRC}/kernel/inotify.c"
  "${ISH_SRC}/kernel/ipc.c"
  "${ISH_SRC}/kernel/ptrace.c"
  "${ISH_SRC}/kernel/native_offload.c"
  "${ISH_SRC}/kernel/fs.c"
  "${ISH_SRC}/kernel/fs_info.c"
  "${ISH_SRC}/fs/mount.c"
  "${ISH_SRC}/fs/fd.c"
  "${ISH_SRC}/fs/inode.c"
  "${ISH_SRC}/fs/stat.c"
  "${ISH_SRC}/fs/dir.c"
  "${ISH_SRC}/fs/generic.c"
  "${ISH_SRC}/fs/path.c"
  "${ISH_SRC}/fs/real.c"
  "${ISH_SRC}/fs/fake.c"
  "${ISH_SRC}/fs/proc.c"
  "${ISH_SRC}/fs/proc/entry.c"
  "${ISH_SRC}/fs/proc/ish.c"
  "${ISH_SRC}/fs/proc/net.c"
  "${ISH_SRC}/fs/proc/root.c"
  "${ISH_SRC}/fs/proc/pid.c"
  "${ISH_SRC}/fs/dyndev.c"
  "${ISH_SRC}/fs/adhoc.c"
  "${ISH_SRC}/fs/sock.c"
  "${ISH_SRC}/fs/pipe.c"
  "${ISH_SRC}/fs/sockrestart.c"
  "${ISH_SRC}/fs/lock.c"
  "${ISH_SRC}/fs/dev.c"
  "${ISH_SRC}/fs/mem.c"
  "${ISH_SRC}/fs/tty.c"
  "${ISH_SRC}/fs/tty-real.c"
  "${ISH_SRC}/fs/pty.c"
  "${ISH_SRC}/fs/tmp.c"
  "${ISH_SRC}/fs/poll.c"
  "${ISH_SRC}/kernel/poll.c"
  "${ISH_SRC}/kernel/epoll.c"
  "${ISH_SRC}/util/timer.c"
  "${ISH_SRC}/util/sync.c"
  "${ISH_SRC}/util/fifo.c"
  "${ISH_SRC}/util/fchdir.c"
  "${ISH_SRC}/util/signpost.c"
  "${ISH_PLATFORM_SRC}"
  "${ISH_VDSO_ELF}")

add_library(ishcore STATIC ${ISH_EMU_SRC} ${ISH_FAKEFS_SRC} ${ISH_CORE_SRC} "${ISH_OFFSETS_H}")
target_include_directories(ishcore PUBLIC
  "${ISH_SRC}" "${GEN}" "${ISH_VDSO_DIR}"
  "${ISH_SRC}/vdso/arm64" "${ISH_SRC}/asbestos/guest-arm64/gadgets-aarch64")
# sqlite3 carries the fakefs metadata (upstream links it for the same reason);
# iOS gets it from the SDK, macOS from the system.
find_library(SQLITE3_LIB sqlite3 REQUIRED)
target_link_libraries(ishcore PUBLIC ${SQLITE3_LIB})
find_package(Threads REQUIRED)
target_link_libraries(ishcore PUBLIC Threads::Threads)
# kernel/vdso.c embeds the elf with `.incbin "libvdso.so.elf"`, so the assembler
# needs the file's own directory on its search path.
set_source_files_properties("${ISH_SRC}/kernel/vdso.c" PROPERTIES
  COMPILE_OPTIONS "-I${ISH_VDSO_DIR}")

# ------------------------------------------------------- the host seam (our code)
# dsh_ish.c is OURS, not vendored: it boots the kernel, mounts the guest root and
# the authorized workspace, and runs one program per call with stdout/stderr
# collected. dsh_ish_verify.c is the integrity-at-every-mount half: it seals
# the staged tree into a manifest at staging time and re-verifies it at every
# boot (no engine dependency — plain POSIX + sha256). Both are compiled here
# so every target that embeds the engine links the same seam.
add_library(dsh_ish STATIC "${CMAKE_CURRENT_SOURCE_DIR}/../dsh_ish.c"
                           "${CMAKE_CURRENT_SOURCE_DIR}/../dsh_ish_verify.c")
target_include_directories(dsh_ish PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/..")
target_link_libraries(dsh_ish PUBLIC ishcore)
# zlib inflates the pinned guest-userland tarball that dsh_ish_stage() extracts
# into the app container (iOS ships libz; macOS has it in the SDK). The engine
# itself never links it — this is our staging seam's dependency, not upstream's.
find_library(Z_LIB z REQUIRED)
target_link_libraries(dsh_ish PUBLIC ${Z_LIB})
# libresolv carries res_ninit, which the staging seeds the guest's resolver from
# (the host's own DNS servers — see dsh_ish.c's stage_seed_resolver). Darwin
# spells it res_9_ninit and links the same library on macOS and iOS.
find_library(RESOLV_LIB resolv REQUIRED)
target_link_libraries(dsh_ish PUBLIC ${RESOLV_LIB})

# ------------------------------------------------------------------- the smoke
# A C-level gate for the seam, runnable without a JS runtime or a simulator:
# it boots the guest and runs the commands given on the command line, printing
# one JSON object per command. tools/e2e/run-ish-local.sh drives it first and the
# JS scenario second, so a failure says which layer broke.
if(NOT ISH_SDK)
  add_executable(ish-smoke "${CMAKE_CURRENT_SOURCE_DIR}/../ish_smoke.c")
  target_link_libraries(ish-smoke PRIVATE dsh_ish)
endif()
