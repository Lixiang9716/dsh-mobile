# Agent Note: the emulated Linux userland is the execution foundation, and its licence and audit consequences are named

Status: implemented
Related: D16

## Problem

The host could run JavaScript and nothing else. A model that needs `gcc` to check a
program, `python3` to crunch a file, `apk`/`pip`/`npm` to install a tool, or a real
POSIX shell to run a pipeline had no path to any of them:

- iOS forbids spawning a child process, and this architecture refuses subprocesses
  anyway (D2) — the "real subprocess ecosystem" was a declared boundary (§12).
- The WebAssembly seam (`wasmRun`, v1.2.0) is a pure-function ABI by construction:
  input string in, `dsh.emit` bytes out, i32 exit. An installed module cannot open a
  file, read argv or see a clock, and the route to a real program ecosystem (a
  registry, a wasm toolchain, every runtime) was entirely in front of us.
- nodejs-mobile/V8 was refused by D1 and is now measured as worse than refused: under a
  legitimate iOS app V8 runs jitless, and jitless V8 has no WebAssembly at all.

Meanwhile the question that kept coming back was "can we install and run real programs?"
— and the answer kept being "not without a userland".

## Decision

`contract/` v1.3.0 adds `ishRun`: **one program in the host's in-process emulated Linux
userland**. A userspace AArch64 interpreter (iSH-arm64, vendored verbatim, sha256-pinned
by `runtime/spike/vendor/ensure-ish.sh`) emulates the guest's instructions *and* its
syscalls inside the app process, so a real Alpine userland runs with no child process and
no second OS. iOS implements it; Android and HarmonyOS answer `unavailable` and keep the
WebAssembly shell (capability negotiation, not a `hostType` branch).

The pieces, each with its own gate:

- **The seam** — `runtime/spike/host/dsh_ish.{c,h}`: boot once (mount the guest root and
  the authorized workspace), then run one program per call as a child of the guest's init,
  with its own pipes and the exit status read off the guest's zombie. Built by
  `runtime/spike/host/ish/CMakeLists.txt` for macOS, `iphonesimulator` and `iphoneos` from
  one project.
- **The tool** — `system-plugins/dsh-shell-ish`: the third executor on the upstream
  `ctx.shell` seam, beside `dsh-bash-local` (a real child process) and `dsh-shell-wasm`.
- **The userland** — `runtime/spike/vendor/ensure-ish-rootfs.sh` pins the Alpine minirootfs
  tarball; `dsh_ish_stage()` extracts it into the app container at first launch. It cannot
  ship as an extracted tree: the userland carries **335 symlinks**, most of them absolute
  (`/usr/bin/top -> /bin/busybox`), and `installd` refuses such an app outright
  (`invalid symlink at …`) — measured, not anticipated. Staging also seeds
  `/etc/resolv.conf`, because no container image carries one and every package manager
  resolves a name before it fetches anything.
- **The gate** — `tools/e2e/run-ish-local.sh`: C gate (the seam, no JS) → staging from the
  pinned tarball → JS gate (scenario → plugin → gateway → guest, 11/11 records) → and a
  **deliverable** the logs cannot fake: the guest writes a file into the mounted workspace,
  the JS layer reads it back through the gateway, and the script compares that digest with
  the file on disk.
- **The iOS leg** — verified in a simulator app that drives the shipped seam: the app stages
  the bundled tarball itself (0.1 s), boots (2 ms), keeps `exit 7` intact, takes a 20 000
  character command line, installs `figlet` with `apk` (30 s) and still has it on the next
  call — 7/7.

## Alternatives considered

- **Stay with the interpreters only.** Rejected: `wasmRun` cannot open a file, and the whole
  ecosystem (registry, toolchain, runtimes) would have to be built before the first real
  program ran. The guest route inherits `apk`/`pip`/`npm` as-is — measured in this repo:
  git, python3, gcc, make, sqlite, jq, bash, curl and Node 22 all install and run inside it.
- **Real subprocesses.** Not available rather than not chosen: iOS permits none, and Android
  10+ blocks `execve` of files in app data (Termux survives by pinning targetSdk 28 and
  leaving Play).
- **Ship the userland as a folder in the bundle.** Rejected by measurement (see above): the
  bundle cannot carry those symlinks, and the container can.
- **Use the engine's own CLI as the tool's backend.** Rejected by measurement: the CLI
  returns 0 for every guest exit status, and a command line ≥16 KB SIGSEGVs the host and
  hangs (`char argv_copy[4096]`, filed upstream as OpenMinis/ish-arm64#42). Only the
  embedded path (child of init + zombie wait) is correct.
- **Claim per-call enforcement.** Refused: the guest's sockets are host BSD sockets and its
  paths are host paths, so the contract's permission flags and audit records do not reach
  inside it. The contract now *requires* the host to state what its audit cannot see
  (§7 point 2), and §12 carries this host's statement.

## Consequences

- **The repository's licence becomes GPL-3.0** wherever the engine is distributed (iSH is
  GPL-2/3; static linking). This repository has no LICENSE file: that is the owner's call
  and the one thing gating a release that contains the engine.
- Guest performance is 11–34× slower than native for compute and 40–108× for jitless Node;
  boot is 41–79 ms in-app, and a desktop-CLI invocation pays ~1 s fixed before the workload.
- The staged userland is data and survives relaunch; running guest processes do not — they
  die with the host process (suspension, memory pressure). D7's checkpoint carries sessions,
  never a live userland.
