# Agent Note: the shell an iOS host can actually have — WebAssembly, interpreted in-process

Status: implemented
Related: D2, D5, D9

## Problem

Told to "port the file tools", the honest answer turned out to be a different
one: the upstream file tool (`dsh-tool-fs` over `dsh-fs-local`) needs five
filesystem operations the contract did not have, and the upstream shell tools
(`dsh-tool-bash` / `dsh-tool-pwsh`) need something iOS cannot provide at all.
`dsh-bash-local` builds a `ctx.subprocess` spawn spec for a real `bash` binary
with a pty; iOS has no shell binary and no way to spawn one, which is why D2
already refuses subprocesses outright ("physically refused on iOS").

So the question was never "which shell do we bundle" but "what can a shell BE on
this host". Three answers were considered:

- **`ios_system`** (the library behind a-Shell/LibTerm): Unix commands compiled
  as functions into the app, `system()` replaced, no fork/exec. Technically
  admissible under D2 and a real option — but it is iOS-only, so the other three
  hosts would each need their own, and the gateway's whole point is one contract
  with no per-host branching.
- **A WASM shell module** (wasmsh, go-busybox, or a busybox build): one artifact
  that runs anywhere an in-process interpreter exists — the symmetric option.
  Note what the search turned up about go-busybox: under WASI its `ash` is
  *stubbed*, because a shell that expects to spawn children has nothing to spawn
  them with. The designs that work are the ones where every command runs
  in-process.
- **No shell at all**: keep only the fs primitives and let the model edit files.
  Rejected — a shell is how an agent does multi-step work.

## Decision

**A WebAssembly seam, and a shell executor built on it.**

`contract/primitives.md` → **v1.2.0**: `wasmRun(scope, path, func, input?)`
loads a module from inside an authorized scope (the same path rule the fs
primitives use, so a module is an ordinary file) and runs one of its exports
**in the caller's own process**. The module reaches the host through the
imported function `dsh.emit(ptr, len)`; the host writes the caller's input into
the last 4096 bytes of the module's memory and passes `(ptr, len)`; the export's
`i32` return is the result. New capability flag `wasm`; nothing else in the
contract moves. The interpreter is **wasm3**, vendored and sha256-pinned by
`vendor/ensure-wasm3.sh` (same discipline as quickjs-ng: untracked tree, the pin
in the script, only the files this repository builds), and the WASI backends are
deliberately left out — the boundary is our own imported functions, not WASI's
descriptor table, and nothing here spawns a process or a thread.

`system-plugins/dsh-shell-wasm/` is the **third executor in the shell family**,
a sibling of `dsh-bash-local` / `dsh-pwsh-local` rather than a new capability:
it presents the same shape the upstream tool layer consumes (`resolve` + a
foreground `run` returning `{exitCode, stdout, stderr}`) and swaps the backend
from a spawned binary to a WASM module. The model's mental model is unchanged —
it writes a command line and reads stdout plus an exit status — but "the PATH"
is now the workspace: `echo hello` runs `echo.wasm`, a module the plugin writes
there on activation if it is missing, and its `dsh.emit` output comes back as
the command's stdout.

Everything else is refused **by name** rather than faked: pipelines,
redirection, quoting beyond whitespace, globbing, environment and background
jobs produce a non-zero exit that says what is missing, and an unknown program
is the shell's own `127 not found`. A command line that cannot be honoured must
never quietly do something else.

## Alternatives considered

- **`ios_system` as the executor backend.** The most mature answer for iOS and
  it would give a real command set today. Rejected as the repo's seam: it is
  one host's library, so Android and HarmonyOS would each need a different
  implementation of "the same" shell, and the contract's asymmetry would land
  exactly where the architecture forbids it.
- **Vendor a WASI runtime (uvwasi, pulled in by wasm3's formula) and run a
  WASI shell.** WASI's filesystem is a preopened descriptor table the host
  fills; mapping it onto the scope-confined fs primitives would put a second
  path-resolution layer between the model and the gateway — and the WASI shells
  that need process APIs are stubbed anyway.
- **wasm2c (translate the module to C, link it) instead of an interpreter.**
  Lower latency and no interpreter in the app, and it sidesteps iOS's JIT rule
  even more comfortably. Rejected for now: it makes every module a build-time
  artifact, so a module the agent writes into its workspace at run time could
  not be run at all — which is the interesting case.
- **Keep the shell logic in the plugin (JS) and let WASM provide utilities.**
  That is not a shell; it is a command dispatcher with a WASM library behind it,
  and the model's `cat file` would be JS pretending to be a program.
- **Wait for a C→WASM toolchain and write the shell in C.** Apple's clang has no
  wasm32 target and no wasm-ld on this machine (measured), so every module today
  is hand-assembled with `wat2wasm`. That bounds what the starter set can be,
  not whether the seam is real — and the seam is what this change is about.

## Consequences

- A model turn now runs a WebAssembly program end to end in the user-facing
  build and renders its output and exit status in the official UI:
  `hosts/ios/artifacts/wasm-shell-e2e/` (screenshots; the model itself observes
  that the `15` exit status could not have come from a Unix `echo`).
- `b4.write.live` still passes **43/43 in order** with the plugin mounted, and
  the manifest now pins `tools: 2` — `todo_write` and `shell`, the honest new
  fact.
- The WasmRuntime is a second engine in the app (wasm3 beside quickjs-ng), so
  CI's vendoring step fetches both; `ensure.sh` delegates to
  `ensure-wasm3.sh` at the top, because its quickjs path exits early on a warm
  tree and a delegation at the end would never run.
- **Honest gaps.** One starter program (`echo`); no `ls`/`cat`; the upstream
  `dsh-tool-bash` is not ported (it needs `dsh-shell` + `dsh-shell-env` +
  `dsh-jobs`, and `system-plugins/dsh-shell-wasm`'s executor object is the seam
  that port wraps, at which point its own tool registration is deleted);
  Android and HarmonyOS have no `wasmRun` implementation, so their runs answer
  `unavailable` and their shell plugins would need their own interpreter
  wiring; and the descriptor still reports v1.0.0's nine primitives for the same
  reason as v1.1.0's additions.
- The toolchain limit is worth stating plainly: **every module shipped today was
  assembled by hand with `wat2wasm`.** A real command set needs a language that
  compiles to wasm32 (Rust, TinyGo, or LLVM's clang), which is a toolchain
  install rather than a code change — the next step for anyone who wants `ls`
  and `cat` rather than `echo`.
