# Agent Note: terminal-bash local joins the shell-suite platform pin — the last pwsh-row ledger item lands

Status: implemented
Related: T-0072 (this wave), T-0070 (the suite-goes-green program), the W8
loader-face ledger (tmp/r3-ledger-W8-loader-face-staged-world.json), the W7-X1
platform pin, D-b (the forkpty face)

## Problem

The W8 loader-face ledger's "blocked-outside-ownedFiles" list ended with two
specs it could analyze but not own: `terminal__terminal-bash__tests__local`
and `shell__tool-pwsh-persistent__tests__loader-composition` — both excluded
by the transpiler's monorepo-src rule for importing
`@deepseek-ai/dsh-pwsh-local/src/resolve.ts` bare, both waiting on "one
SUBMODULE_SRC_HOISTS row". The dispatch for this wave asked for two hoist
rows, one per spec.

## Decision

Reality had moved past the ledger on the transpile half: the resolve.ts row
had already landed on main (678d99dc, added verbatim as the ledger described,
key `@deepseek-ai/dsh-pwsh-local/src/resolve.ts` →
`packages/shell/pwsh-local/src/resolve.ts` — the single specifier BOTH specs
import; there is no second src/ specifier to hoist, verified by reading both
specs' import lists). Both specs stage on current main (681 transpiled,
manifest byte-identical to the committed one). What actually remained:

- `terminal__terminal-bash__tests__local` staged but failed 6/6 at plugin
  load: subprocess-local's `createProcessInspector` (vendored
  runner-launch chunk, line 673) throws on every platform spelling but
  darwin/linux/win32, and the leg's 'mobile' default never reaches the
  forkpty child. Fix: the spec joins `SHELL_SUITE_SPECS` in
  scenario/upstream-suite-leg.js — the established W7-X1 mechanism, already
  extended once by the D-b wave for the same vendored gate — pinning the
  honest uname platform on the desktop spike. Result: passed:6 failed:0.
  The harmony rawfile mirror of the leg is synced in the same commit (the
  vendor-official no-op guard requires it).
- `shell__tool-pwsh-persistent__tests__loader-composition` stages, loads,
  and reports failed:0 with 0/0/0: its only suite is gated by upstream's own
  `hasPwsh` spawnSync probe (real PowerShell), absent on this desktop. That
  is upstream's intent, the same honest shape as its bash twin
  (tool-bash-persistent loader-composition) that already rides the suite.

## Alternatives considered

- **Adding a second transpile hoist row** (the dispatch's literal ask):
  refused as a no-op — both specs' only bare src/ import is resolve.ts, whose
  row already exists; inventing another specifier would hoist nothing.
- **Installing pwsh on the desktop** so the pwsh suite's tests actually run:
  deferred — a host-provisioning decision (CI images included), not a repo
  change; the staged spec reports its skip honestly until then.
- **A global platform flip** (pin `__dshProfilePlatform` for every staged
  spec): still out — 70 staged specs read process.platform and the W7-X1
  note's blast-radius reasoning stands; the pin list grows one verified
  member at a time.

## Consequences

The W8 ledger's blocked list loses its transpile-family pair: both specs are
staged, one runs its six real-shell tests green over the forkpty face, the
other reports upstream's own skip until a pwsh-bearing host runs it. The
pin's condition is provably spec-scoped: each sweep spec runs in its own CLI
process and the stem matches exactly one staged spec.
