# Agent Note: panel-tests invokes vitest through the package entry, not the .bin face (Windows npm writes a shell shim there)

Status: implemented

## Problem

`gov task close` runs its receipt DAG without change scoping — all 27
mode gates must pass wherever the close happens, so panel-tests has to be
green on every seat, not just CI's Linux runners. On this Windows seat the
gate failed in four stacked ways, each hiding the next:

1. `run.sh` ended with `exec "$NODE" ./node_modules/.bin/vitest run`; on
   Windows npm writes `.bin/vitest` as a Bourne-shell shim (no symlinks to
   point at `vitest.mjs`), so node parsed shell as JavaScript and died with
   `SyntaxError: missing ) after argument list`. Red on every local
   mode=all run on this seat (it blocked two card-close sessions,
   2026-10-07) while green on CI.
2. The fs-shim suites staged their real-disk fixtures with
   `join(tmpdir(), …)`; on Windows `tmpdir()` is a `C:\Users\…` spelling
   the shims refuse (`mountWorkspace needs an absolute POSIX root`).
3. The shim family models a POSIX device, but inside a Windows-hosted node
   process `node:path` is win32 — the first shim-internal join
   backslash-contaminated the '/'-prefixed spelling and the containment
   gate refused it (`path '\tmp\…' is outside the writable workspace root`).
4. The vendored fs-local branches on `process.platform` (its ENOENT
   ancestor walk stats the existing ancestor only on win32), and the
   climb-out fixture climbed to `/etc/passwd` — held on the Linux CI host,
   absent as `D:\etc\passwd` on Windows — so the loop-v2/z3 pins answered
   with host-shaped semantics the device never serves.

## Decision

- `test/panel/run.sh` execs vitest through the package entry
  (`./node_modules/vitest/vitest.mjs run`); on POSIX that file is exactly
  what the `.bin` symlink points at, so CI's invocation is unchanged, and
  on Windows it skips the shim. The provisioning check still looks at
  `.bin/vitest` (npm creates it in both layouts).
- New `test/panel/posix-fixture.mjs`: `mkdtempPosix` stages real fixtures
  at '/tmp/…' spellings — one spelling the shims, the seam fakes, and node
  all agree on (node resolves the leading-slash form against the process
  cwd's drive, which the vitest parent and the spawnSync'd toolface
  runners share).
- New `test/panel/path-posix.mjs`, aliased over 'node:path' in
  `vitest.config.js` and mapped the same way in `toolface-loader-hooks.mjs`
  (the stub module itself exempted so its `createRequire('node:path')`
  reaches the real builtin): the shim world's path algebra pins to the
  posix namespace on every host. Host-side code keeps working — node's fs
  accepts forward-slash Windows paths.
- Both toolface runners present `process.platform === 'posix'` before
  importing the vendored closure: the runner already fakes the C seam over
  real node and mounts a '/'-prefixed workspace — the platform stub
  completes the device simulation so the pinned semantics are the device's.
  A no-op on the POSIX CI runners.
- The climb-out fixture now climbs to the runner's own staged outside tree
  instead of `/etc/passwd`: the containment anchor rides existence ("what
  the host actually holds", loop-v2), and the staged tree is held on every
  host, so the pin tests the same semantic without assuming a
  Linux-shaped root filesystem.

## Alternatives considered

- Delete `test/panel/node_modules/` before closing so the gate's
  self-provisioning path re-runs: rejected — the shim exists on Windows
  after EVERY provision, so the failure would just re-arrive one run
  later.
- Call the `.cmd` shim on Windows (`vitest.CMD`): rejected — branching the
  runner by OS doubles the surface for one invocation, and `cmd //c` from
  a `sh` gate drags in quoting hazards the direct entry avoids.
- Patch the shim family to force `path.posix` internally: rejected for
  this change — it is product-surface bytes (host mirrors, parity
  evidence, closures re-sync) where a test-side alias pins the same
  algebra; the shim change remains the right follow-up if device
  simulation spreads to more seats.
- Fake `/etc/passwd` existence in the seam: rejected — the seam fakes
  answer real node for real disk; lying about host state to satisfy an
  assertion is the evidence defect this plane cannot forgive.
- Skip panel-tests from the close mode: rejected — parking a gate to get
  green is the move this plane cannot forgive; the suite itself runs
  clean once the entry resolves and the world is spelled POSIX.
