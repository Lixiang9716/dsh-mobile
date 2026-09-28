# Agent Note: the wasm import surface is a thin kernel interface

Status: implemented
Related: D18

## Problem

`wasmRun` (contract v1.2.0) is a pure-function ABI — input buffer in, `dsh.emit`
out, i32 exit — and the direction already agreed for it (the WASI-lite fill plan,
2026-09-24) will grow it an import surface: files, clock, argv/env, streams. The
moment a surface exists, it has a shape, and two shapes are on the table: a
userland libOS that re-implements a kernel inside the runtime (the WASI-runtime
formula), or a thin interface whose every import is enforced where the resource
actually lives. The research record sharpened the choice the same week the
agent-VM conversation did: WALI (ASPLOS 2024) argues for thin kernel interfaces
and against fat userland emulation, and the wasm+unikernel line (Mewz 2024,
Unikraft's Bunny/urunc) prices the "outer isolation layer" idea for our hosts.
Nothing in the repository yet records which shape this project commits to, so
the future contract proposal would be free to grow the surface fat.

## Decision

D18 is recorded: **the wasm import surface is a thin kernel interface**. Every
imported function is one gateway primitive; enforcement and the per-call audit
record happen at the gateway, never in a userland kernel re-implementation; the
surface is trimmed to the critical mass a real application needs; any addition
requires a contract change (D5). The unikernel route is assessed not applicable
on-device (no app-accessible hypervisor on any of the three hosts; the OS app
sandbox already is that layer) and named as the hardening route for a future
server/cloud deployment of the same VM image. The principle lands before the
WASI-lite contract proposal exists so the proposal inherits the vocabulary.

## Alternatives considered

- **WASI runtime as the seam (uvwasi-style libOS)** — rejected: re-implements a
  kernel in userland (what WALI argues against) and duplicates enforcement the
  gateway already owns; the shell-executor note (2026-09-22) reached the same
  verdict for `dsh-shell-wasm`.
- **Defer the principle to the contract proposal itself** — rejected: recorded
  before design, a constraint shapes the vocabulary for free; recorded after,
  it fights the shipped shape.
- **Unikernel layer on the phones** — not available rather than not chosen: no
  hypervisor for apps on iOS/Android/HarmonyOS.
