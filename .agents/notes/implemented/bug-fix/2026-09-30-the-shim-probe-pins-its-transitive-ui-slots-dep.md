# The shim exposure probe pins its transitive dsh-client-ui-slots dependency

Status: implemented

## Problem

The shim exposure probe (`runtime/spike/scenario/shim-exposure-probe.js`)
statically imports `upstream/shims/slot-registry.js`, whose second line of
business imports `/vendor/npm/@deepseek-ai/dsh-client-ui-slots@0.1.6-alpha.2/lib/index.js`.
That package was never in the npm pin table (`NPM_PACKAGES` in
`runtime/spike/vendor/ensure-dsh.sh`): no *staged* scenario had ever reached
`slot-registry.js` before — the exposure survey itself classifies it as the
thin tail (5/648 specs) — so nothing forced the pin. Consequences on a cold
materialization (exactly what CI is after a cache restore: 25 npm pins +
60 dsh mirror packages):

- `tools/check-staging.mjs --block harmony,android,ios` reports one iOS
  broken edge (`slot-registry.js:22` → unresolvable `/vendor/npm/...`),
  exits 1;
- `.gov/rejections/case-staging-check.sh`'s green leg ("restored tree
  green") therefore fails → `self-test` fails → the `gov`/`gates` check
  fails;
- and worse: a cold probe run would die at load time — the committed 8/8
  evidence was only reproducible on a machine carrying a stale, pre-trim
  fat vendor tree (`vendor/npm/@deepseek-ai/*` ≈ 190 packages) that masked
  the missing pin.

The branch's own CI never surfaced this until the branch's first real CI
run, because GITHUB_TOKEN pushes had suppressed every workflow event for
it (see `.github/workflows/gov.yml`'s own comment).

## Decision

Pin `@deepseek-ai/dsh-client-ui-slots@0.1.6-alpha.2` through the mechanical
layer (`runtime/spike/vendor/add-package.sh fetch`): sha256
`90ef036a6622b027dfbcb46986122eda45e7d0f7617d9fa82aa3d444a99ac887`, mirror
tarball committed under `runtime/spike/vendor/dsh-tarballs/`, one
`NPM_PACKAGES` row in `ensure-dsh.sh`. The pinned tarball's `lib/index.js`
is byte-identical to the copy the committed 8/8 probe evidence ran against,
and carries the three named exports `slot-registry.js` imports
(`SlotCore`, `StaleAuthorizationError`, `standardHookPropName`). No embed
rows follow: the host stagers carry explicit CLOSURE lists (verified — the
closures gate reports the committed android/harmony copies byte-identical
and the iOS generator green with the pin landed), and no product boot
reaches `slot-registry.js`; the package serves the CLI probe's load and the
staging walk's existence check.

## Alternatives considered

- **Make the probe import `slot-registry.js` dynamically (or not at all)** —
  rejected: it would weaken the probe's fifth leg (the slot registry's
  boot-once/registration guards) to dodge a real dependency instead of
  declaring it; the survey's whole point is that thin-tail shims are
  honestly load-bearing somewhere.
- **Teach `check-staging` to tolerate unresolved `/vendor/npm` edges from
  shims** — rejected: a cold tree must reproduce committed evidence, and a
  checker hole that swallows a missing package is a silent pass (rule 6).
- **Leave it and let the probe stay fat-vendor-only** — rejected: the
  survey's evidence would not survive a cache eviction; "runs on my
  machine" is the failure the pins exist to prevent.

## Consequences

Cold materializations now resolve the probe's full import graph; the
staging walk and the CLI probe agree on one pinned set. The vendor cache
key (`hashFiles(ensure.sh, ensure-dsh.sh)`) rotates with this change, so
CI re-materializes once.
