# Agent Note: the simulator matrix invokes the bash-only ensure scripts with bash — dash cannot run set -o pipefail

Status: implemented
Related: T-0165, D9

## Problem

The simulator matrix's Android leg died at materialize() step 3 on this WSL2
box (matrix run log, 2026-10-02): `sh test/e2e/ensure-official-dist.sh`
exited with `ensure-official-dist.sh: 9: set: Illegal option -o pipefail`,
`mx_die` fired, and the Android matrix produced zero legs (harmony skipped
honestly; the summary table showed only the harmony SKIP row). /bin/sh on
this box is dash; `ensure-official-dist.sh` and `ensure-client-bundles.sh`
are `#!/usr/bin/env bash` scripts whose line 9 is `set -euo pipefail` and
which resolve their root via `BASH_SOURCE` — both bash-only. The other two
materialize() legs (`ensure.sh`, `ensure-dsh.sh`) are POSIX-clean
`#!/bin/sh` scripts, which is why the same `sh` prefix worked for them and
hid the interpreter mismatch until the third line.

The failure was previously masked locally by a session-local PATH shim
(sh→bash) from the T-0156 round; the 2026-10-02 matrix run executed from a
bare shell and exposed it. Every other caller in the repo invokes these two
scripts bare (`hosts/ios/artifacts/release-logging/run.sh`,
`hosts/harmony/ci/vendor-official.sh`, mode `bash "$s"` in the Android
release-logging run) — the shebang (and 100755 in git) decides — so the
matrix script's explicit `sh` prefix was the only interpreter-overriding
call site.

## Decision

`tools/test/run-simulator-matrix.sh` invokes the two bash-only ensure
scripts with `bash`, and `hosts/ios/Tools/sim-preflight.sh` (also
`#!/usr/bin/env bash`) likewise; the POSIX-clean `ensure.sh`,
`ensure-dsh.sh`, and `hosts/ios/gen.sh` keep their `sh` prefix. Proof: on
main, `sh test/e2e/ensure-official-dist.sh` reproduces the dash rejection
(the bug's rejection case); after the change the materialize invocation is
`bash …` and the script exits 0 (dist present + MANIFEST verified).

## Alternatives considered

- POSIX-ifying the two ensure scripts (drop `pipefail`, replace
  `BASH_SOURCE`): lost — pipefail is load-bearing for the verify pipeline,
  and rewriting two verified scripts to serve one caller inverts the
  burden.
- A dash→bash re-exec guard inside each bash-only ensure script
  (`[ -z "${BASH_VERSION:-}" ] && exec bash "$0" "$@"`): viable, but it
  adds a stanza to two scripts to protect against a call pattern that
  exists in exactly one place; fixing the call site keeps the interpreter
  choice next to the invocation, where every other caller already makes it
  correctly.
- Restoring the T-0156 PATH shim in the matrix environment: lost — a
  session-local env mask is precisely the silent-skip class rule 5 forbids;
  the matrix must run green from a bare shell or it is not evidence.
