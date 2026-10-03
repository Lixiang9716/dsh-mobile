# Agent Note: the release seat's shell executes — wasmRun served on Android, plus a real starter set

Status: implemented
Related: D2, D5, D6, #335 (audit leg B4), the 2026-09-22 wasm-shell note

## Problem

The audit's B4 row: the release seat's `shell` tool could not execute
anything. The executor (`system-plugins/dsh-shell-wasm`) answers every
command by loading `foo.wasm` through the gateway's `wasmRun` primitive — but
on Android that primitive had a grant in the manifest and NO handler anywhere
(not in the Kotlin `GatewayCore` dispatch, not in the C layer: `dsh_wasm.c`
and wasm3 were iOS/desktop-only compiles). So `echo hi` — the executor's own
starter — settled as a gateway denial with exit 126, `ls`/`node` answered
`127 not found`, and the "Retry terminal recovery" chip was the honest UI for
a tool that could never work. The model hand-rolled every file operation with
the fs tools.

The audit's preferred fix — wire the iSH Linux userland into the seat — was
assessed and does not fit one round: the arm64 engine needs sqlite3
(the guest filesystem's metadata store) and libresolv, neither of which the
NDK ships; `platform/linux.c` is a desktop-Linux file untested against
bionic; and the Alpine rootfs needs the iOS-style tarball-in-assets staging
pipeline (335 symlinks, `dsh_ish_stage`) plus a Kotlin staging seam. That
remains the follow-up for shell realism's second half.

## Decision

**`wasmRun` is served on Android, and the starter set grows from one program
to three.**

- The C seam is shared, not reimplemented: the Android CMake compiles the
  same `host/dsh_wasm.c` + the same 11 wasm3 TUs the iOS app and the portable
  spine compile (pin: `vendor/ensure-wasm3.sh`, materialized by the existing
  `ensureSpikeVendor` Gradle task — no new vendored bytes). JNI exposes two
  statics (`nativeWasmRun`, `nativeWasmLastError`, the m4LastError pattern);
  `WasmPrimitive` (Kotlin sibling of the iOS wasmRun leg in
  `FSPrimitives.swift`) reads the module through the same scope registry the
  fs primitives use — `FsPrimitives.readFor`, factored out of the fsRead
  handler — and answers the iOS handler's exact rejection shapes, including
  `io "cannot read <path>"` for a missing module, the message the shell
  executor's not-found branch matches on. Registered in all four seats
  (`SessionServe`, `SessionLiveSession`, `SessionWriteSession`,
  `SpikeHostM4`).
- The starter set is `echo`, `wc`, `grep` (`STARTERS` in the plugin;
  `ensureStarters` writes each once, never overwriting an existing copy —
  so old workspaces keep the byte-identical echo). `wc` prints
  `<lines> <words> <bytes>` of its input; `grep` is a fixed-string filter
  (`<pattern> <text>`, exits 0/1/2 the grep convention). Both compute over
  the ONE input channel the contract's ABI carries — the argument text,
  which a multi-line command makes multi-line. The 2026-09-22 note's
  rejected alternative ("keep the shell logic in the plugin and let WASM
  provide utilities — the model's `cat file` would be JS pretending") is
  respected: there is no file-feeding convention; file work stays refused,
  and the 127 message now says so and names the fs tools.
- The generated programs are reproducible artifacts: reviewable `.wat`
  sources in `tools/wasm-gen/`, compiled by a pinned wabt (1.0.39, its own
  `package.json` — the #327 tarball-pin discipline in npm form), verified
  against the `dsh_wasm.c` ABI by the generator BEFORE anything is written,
  and committed as byte arrays + sha256 pins in
  `system-plugins/dsh-shell-wasm/programs.js`. The panel suite re-checks the
  pins and re-executes the bytes, so drift fails the suite, not a device.
- The honest surface: the not-found refusal names the available programs and
  routes file operations to the fs tools; the tool description does the
  same, including the wc/grep text-processing contract and the multi-line
  input fact.

## Alternatives considered

- **Wire iSH into the release seat now (the audit's route 1).** The real
  answer for shell realism, and it lost this round on dependencies, not
  desire: sqlite3 + libresolv are not NDK libraries, the engine's
  platform layer is unported to bionic, and rootfs staging is a pipeline,
  not a flag. Recorded as the follow-up; nothing in this change blocks it
  (ishRun keeps answering through the same gateway when it lands).
- **Feed file contents to the modules through the input channel** (executor
  resolves `wc file.txt`, passes the bytes). Rejected: it re-introduces the
  "JS pretending to be a program" shape the 2026-09-22 note rejected, needs
  a per-program input protocol (grep's pattern and the file content fight
  over the ABI's one string), and the ABI's C runner truncates input at
  NULs. The honest line stayed: modules compute on the command text; files
  belong to the fs tools, and the refusal says so.
- **Vendor prebuilt coreutils WASM binaries** (wasi-sdk builds of real
  busybox/coreutils). Lost to the generated-wat route on reviewability and
  pinning: a 100+ KB WASI blob is not reviewable in a PR, WASI's libc wants
  descriptor-table imports this host deliberately does not serve (the
  vendored wasm3 ships no WASI backends), and the binary-waste rule
  (AGENTS.md) forbids committing build outputs. A 353-byte `wc` and a
  467-byte `grep` with their `.wat` sources in the same commit carry the
  same honesty in a readable form.
- **Compile wc/grep from C with a wasm32 toolchain** (clang --target=wasm32).
  The 2026-09-22 note's own "next step", and still right for a bigger
  command set — but it adds a toolchain dependency for two programs whose
  whole logic fits on one screen of WAT each. The generator + wabt pin is
  the lighter artifact with the same reproducibility; a C toolchain can
  replace the wat set without touching the executor or the seam.
