# wasm-shell-e2e — a WebAssembly shell running in the user-facing app

The end-to-end acceptance for the WebAssembly seam (contract v1.2.0 `wasmRun`)
and the shell executor built on it: the model is given a `shell` tool, runs a
command line, and the result renders in the official UI.

## What the screenshots show

- `01-tool-call.png`, `03-clean.png` — one real turn. The header reads
  **1 次工具调用 · 1 条消息**; the assistant reports the command's output in a
  terminal card (`hello from wasm`, with the UI's copy affordance) and the
  **exit code** below it; the turn counter reads `1 轮 2 步`.
- The model's own note in the same turn is worth reading: it points out that a
  conventional Unix `echo` would exit `0`, so `15` must come from the
  workspace's WebAssembly module rather than a shell builtin. It is right — the
  starter `echo.wasm` returns the length of the text it emitted — and it is the
  clearest evidence that what ran was a WASM program and not a Unix utility.

## The chain the screenshot proves

```
model: shell { command: "echo hello from wasm" }
  → system-plugins/dsh-shell-wasm   (the shell executor: parse, dispatch, exit status)
  → gateway `wasmRun`               (contract v1.2.0, scope-confined module path)
  → wasm3 in-process                (vendored + sha256-pinned; no subprocess, D2)
  → echo.wasm in the workspace      (77 bytes, written by the plugin on activation)
  → dsh.emit(ptr, len)              (the module's output channel, host-linked)
  → terminal card in the official UI
```

`verdict-b4-write-live.json` is the regression this rode in on: the harness's
own `b4.write.live` drive still passes **43/43 in order** with the shell plugin
mounted, and the model is offered exactly **2** tools (`todo_write`, `shell`).

## Reproduce

```sh
tools/e2e/run-ios-b4.sh --art-dir ~/dsh-verify/b4-shell   # the regression + tool count
# then, for the screenshot: a Release build with a real model endpoint staged,
# tools/e2e/ios-ui.py to drive it, and a prompt asking for the shell tool.
```

## Honest limits of this increment

- One starter program (`echo`). A program is a module in the workspace, so the
  command set grows by adding modules — but nothing here ships `ls`, `cat` or a
  real shell parser.
- No pipelines, redirection, quoting, globbing, environment or background jobs.
  A command line needing them fails with a non-zero exit naming what is missing
  rather than running something quietly different.
- The upstream shell tool (`dsh-tool-bash`) is NOT ported: it needs
  `dsh-shell` + `dsh-shell-env` + `dsh-jobs` vendored, and this plugin's
  executor object is the seam that port wraps.
