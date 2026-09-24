# The upstream-suite sweep's first full run — shim gap-fill + a latent TextDecoder product bug

Status: implemented

Date: 2026-09-25 · Class: bug-fix · Follows: the upstream-suite legs
(`run-ios-upstream-suite.sh`, scenario `upstream.suite`) and the
models-directory e2e change of the same day.

## Problem

The upstream dsh-tests suite had only ever been proven one spec at a time
(the agent-loop loop spec, 65/65). Nobody knew how the full 262-spec
transpiled tree actually behaves on this runtime, so the shim layer's gaps
were discovered one product bug at a time. The first full two-leg sweep
(QuickJS CLI + Node reference, `runtime/spike/ci/run-upstream-suite-sweep.sh`)
found 145 non-green specs — and inside them, one latent PRODUCT bug: the
global `TextDecoder` served by `shims/util.js` called a bare `decodeUtf8`
in its NON-FATAL branch (the default!) without ever importing it — any
non-fatal decode would crash with a ReferenceError. The product surfaces
dodged it only because the closure's decode paths ride `Buffer`/fatal
branches.

## Decision

Six fixes, all verified by re-running their demanding specs, then a full
sweep re-run (262 specs):

- `shims/util.js` — TextDecoder imports the decoder its non-fatal branch
  calls (the product bug; `dsh-output-retention`'s 23 decode tests went
  green, 36/36).
- `shims/buffer.js` — `Buffer.from(string, enc)` gains the single-byte
  family (ascii/latin1/binary; lossy 8-bit truncation, node's mapping).
- `shims/url.js` — `fileURLToPath` resolves scheme-less RELATIVE paths
  (the loader's `import.meta.url` spelling for bundle-relative modules,
  i.e. every transpiled spec) against the bundle root.
- `shims/fs.js` — loud link stubs `mkdtempSync`/`symlinkSync`: an ESM
  named import from a missing export is a link error even when the call
  site is never reached, so the export set is itself the contract.
- `shims/fs-promises.js` — `rmdir` (delegates to the workspace rm; the
  view has no empty-dir bookkeeping, declared in the row) and `symlink`
  (loud: the workspace link seam is hard-link only).
- `scenario/upstream-suite-leg.js` — pins `__dshProfileHome` alongside the
  cwd/tmpdir pins (the driver is the boot prelude for the suite).
- Promoted the sweep runner: `runtime/spike/ci/run-upstream-suite-sweep.sh`
  (diagnostic output to gitignored `tmp/` — the matrix's receipts only
  come from green runner runs, and the sweep deliberately reports failure
  classes it cannot own).

Numbers: green 117 → 119, module-gap 89 → 81, and 6 specs moved from
load-failure to running (dozens of newly-passing tests, e.g.
sandbox-policy 18/19). Shim table row added to
`runtime/spike/upstream/README.md`.

## Alternatives considered

- **Driving the sweep to full green**: rejected — ~75 module-gap specs are
  structurally out (19 need the desktop's bundled runner-launch chunk, ~15
  the native seams `child_process`/`vm`/`sqlite`, ~15 import vendored
  packages' `.ts` SOURCE paths that npm tarballs don't carry, plus
  typescript/landlock/turndown-class deps). Making them green means
  reversing settled architecture (D2 single-thread, the PTC confined
  realm), not fixing bugs.
- **Vendoring more packages** (mcp-client, cordis-plugin-group, fflate):
  rejected for this change — the specs demanding them mostly import
  `.ts` source paths, so vendoring the built lib wouldn't satisfy the
  import; per-package vendor flow cost outweighed ~5 specs.
- **Fixture staging for the preset__agent-presets family** (5 specs now
  load and run but fail on missing `/upstream-tests/fixtures`): deferred —
  it is a transpile/staging pipeline decision (what gets staged where per
  host), not a shim fix; the specs execute their 19 tests and fail
  honestly.

## Consequences

The sweep is reproducible locally in minutes and becomes the regression
net for the shim layer; the 0.1.7 re-pin should re-run it (the report's
gap clustering will re-derive against the new closure). The known residual
classes are named in the sweep report: fixture staging (pipeline),
symlink/realpath semantics in the staged fs, lsp framing payload decode,
and the per-spec behavioral tails (SessionSeq semantics, IANA timezone
validation, tool-session-query mock shape).
