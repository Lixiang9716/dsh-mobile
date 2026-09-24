# Agent Note: the tool rows embed from the npm face they are pinned at — the silent-empty rglob dies

Status: implemented

## Problem

PR #206's tool-rows round could not go green, and neither could main
(since #202-#204). Three independent drifts, one of them silent:

1. **The iOS embed shipped the wrong bytes for tool-bash and none at
   all for the other three.** The four TREES rows
   (`tool-present`/`tool-ralph`/`tool-bash`/`tool-pwsh`) resolved their
   byte source to `vendor/dsh/<pkg>@0.1.6-alpha.2` — the mirror face —
   but ensure-dsh.sh materializes them on the npm face
   (`vendor/npm/@deepseek-ai/dsh-tool-*@…`). `Path.rglob` on an absent
   directory yields NOTHING without an error, so the generator silently
   embedded zero files for the three packages with no local tree; for
   tool-bash the author's dev tree happened to carry a stale monorepo
   extraction (tsconfig.tsbuildinfo, background/render stragglers, a
   different package.json), and THAT went into the committed
   SpikeBundle.c. CI's fresh materialization produced a different
   bundle → the closures gate's drift, on every run.
2. **The bundle-files gate cannot pass a fresh checkout.** Its
   documented contract is "the vendor script materializes the harmony
   rawfile closure before any check runs", but gov.yml only materialized
   `runtime/spike/vendor` — and the rawfile's pinned zod closure is
   deliberately gitignored, so on CI the disk walk found no zod files
   while BUNDLE_FILES listed them. The self-test's
   `case-bundle-files.sh` rejection proof then failed on its restore leg
   for the same underlying reason (the restored tree still fails when
   the baseline tree fails).
3. **The task gate went stale wholesale**: the #202-#204 governance
   rounds moved `rules` to `974f3cdb03e3`, leaving twelve open cards
   pinned to `c6062b8cdc3b`.

## Decision

- TREES rows are `(staged rel path, byte source)` and the two faces
  genuinely differ, so the four rows keep their `vendor/dsh/<pkg>@ver`
  rel path — that is the directory WebBootRuntimeDrive's
  `agentPresetsSeedDelivery` walks when it writes the preset-health
  node_modules markers — and take their bytes from the npm face, the
  pin's canonical location (the published tarball ships exactly its
  `files` field: lib/index.js + .d.ts; the monorepo face's extra lib
  files are build artifacts no export reaches).
- `collect_tree_files` now refuses a TREES row whose source directory
  does not exist. An absent tree must never pass silently: that guard
  would have turned this PR's silent omission into a loud local failure
  before anything was committed.
- The stale `runtime/spike/vendor/dsh/tool-bash@…` dev-tree leftover is
  deleted (untracked; the npm face is the only copy now).
- gov.yml stages the harmony spike closure
  (`vendor-official.sh --closure-only` — no network, no officialweb
  re-sync) before the DAG, then asserts `git diff` is empty on the
  tracked rawfile paths: the staging must be a no-op there, which keeps
  the closures gate's byte-verification of COMMITTED copies honest
  instead of letting the workflow heal drift the gate should name.
- Task bookkeeping: the ten landed briefs are voided with reasons
  naming where the work shipped (no fabricated receipts — `close` would
  re-run the whole DAG per card for ceremony), the two live briefs are
  re-pinned (T-0033 waits on the z.ai quota, T-0046 is the android
  seat), and the harmony gap the tool-rows round left behind is filed
  as T-0048.

## Alternatives considered

- Committing the zod closure into the harmony rawfile to satisfy the
  disk walk — overturns a deliberate, twice-documented gitignore
  decision (verbatim upstream bytes the syntax checker cannot parse).
- Teaching check-bundle-files.mjs to materialize or to skip gitignored
  paths — either moves the contract into the checker; the vendor script
  owning materialization is the documented shape.
- Closing the stale cards with `gov task close` — honest receipts, but
  each close re-runs the full DAG; ten runs of ceremony for briefs
  whose work shipped weeks ago under other cards' receipts.

## Consequences

The regenerated SpikeBundle.c is byte-identical between the dev tree
and a fresh-clone CI-shape materialization (proven against a scratch
clone before pushing), so the closures gate is deterministic again.
The four tool packages ride the embed with marker-seedable paths, so
the mobile preset's roster rows resolve on device. CI materializes the
harmony closure itself, and any committed-rawfile drift fails the
workflow at the staging step with the sync remedy. T-0048 tracks the
harmony-side staging of the four rows (functional gap, not a CI one —
harmony's closure list has no rows for them yet).
