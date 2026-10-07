# Agent Note: parity-node-modules' embedded node -e paths resolve on Windows shells (cygpath -m before require)

Status: implemented

## Problem

The vendoring-repro gate (the fresh-clone proof the task-close DAG runs)
died on Windows-hosted shells at the first vendored package:
`parity-node-modules.sh` reads each package's npm name with
`node -e "require('${dir}package.json')"` — the directory path is embedded
INSIDE the `-e` script string. MSYS argument conversion only rewrites
standalone path arguments, so on git-bash the embedded POSIX path
(`/tmp/dsh-vend-repro.*/clone/runtime/dsh/vendor/dsh/...` inside the gate's
fresh clone) reached Windows node.js verbatim and died in the CJS loader
(`Cannot find module '/tmp/...'`). Linux CI never sees this (paths are
already native), which is why the gate is green there and red on every
local Windows DAG run since this seat took over the repo (2026-10-06):
no task card could close with a mode=all receipt on this machine.

## Decision

`parity-node-modules.sh` gains a `pkgname <dir>` helper that both `node -e`
call sites use: it converts the directory through `cygpath -m` (drive-letter
form node.js accepts, forward slashes so no JS escaping is needed) when
cygpath exists, restores the trailing slash cygpath drops (the call sites
concatenate `package.json` directly onto it), and then reads the name. On
Linux cygpath is absent and the path passes through verbatim — the gate's
CI behavior is unchanged.

## Alternatives considered

- Run the gate under WSL bash: rejected — the DAG spawns `sh` from the
  Windows PATH, and the same seat's self-test cases proved WSL bash mangles
  the repo's POSIX assumptions differently (mount-path surprises), not
  fewer of them.
- Convert at the call sites inline: rejected — the conversion + trailing
  slash restoration is three lines, duplicated twice, and the next embedded
  path would resurrect the defect; one named helper states the invariant
  once.
- Skip vendoring-repro on Windows: rejected — that parks a gate to get
  green, the exact move this plane cannot forgive; the proof itself is
  sound, only its path spelling was POSIX-only.
