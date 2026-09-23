# Agent Note: the upstream DSH test suite runs on our runtime — the iOS simulator leg, the macOS sweep, and the gap map

Status: implemented

## Problem

PR #161 landed the upstream-suite machinery (transpile pipeline, quickjs-shaped
harness, CLI proof of loop.spec 65/65 under vitest) but the suite had never
run on OUR mobile host, and the vendoring that feeds it had never executed on
macOS: `ensure-dsh-tests.sh` shipped with three defects — a GNU-tar
`--wildcards` extraction that under bsdtar produced an EMPTY tree while
`|| true` swallowed the error and the stamp still claimed present; ~188
closure-block entries whose names doubled the `dsh-` prefix (fetching
`@deepseek-ai/dsh-dsh-X` → 404 body → checksum fail); and BSD-hostile
`mktemp` templates.

## Decision

The suite now executes across our hosts, and the first two gap-fill rounds
shipped. Concretely: (1) `ensure-dsh-tests.sh` is portable (a full extract +
copy-out needs no pattern support from either tar; the stamp is only written
over a non-empty tree; full package names everywhere — the same convention
`parity-node-modules.sh`'s symlinks already assumed); (2) the iOS simulator
gained the `upstream-suite` drive end to end — `-dsh-scenario upstream-suite`
whitisted, the leg + harness embedded in the app bundle, the transpiled spec
staged by the new `test/e2e/run-ios-upstream-suite.sh` into
`Documents/upstream-tests/` and lifted into the rebuilt-per-launch bundle root
by `SpikeBundleStager.writeStagedSpecs`, the spec path riding the launch env
(`SIMCTL_CHILD_DSH_UPSTREAM_SPEC` → the launch-env snapshot, the same
host-facts shape the parity drive uses; the leg keeps the device carriers'
runtime.config handoff); (3) the harness carries `AbortController` +
`structuredClone` shims (see the fork note for the engine side); (4) a full
252-spec sweep ran on the macOS CLI — **before the gap-fill: 12 green / 17
partial / 223 red; after: 31 green / 16 partial / 6 red-with-summary / 199
blocked on missing vendored modules** — with every log, the inventory
(`inventory.{json,md}`), and the exclusion table (602 upstream specs the
transpiler names-and-counts out: esbuild-failed 421, vi.waitFor 79, vi.mock
45…) preserved as evidence. The marquee leg: **loop.spec 63/65 on the iOS
simulator, byte-identical counts to the macOS CLI** — the two failures need a
real `setTimeout` (the timer seam this runtime deliberately lacks; the
transpiler excludes fake-timer specs on the same principle).

The remaining 199 blocked specs resolve into a classified map (83 unique
missing specifiers): one npm-published-at-tag package (`dsh-plugin-manager`),
~40 monorepo-internal packages with NO 0.1.6-alpha.2 tarball (rc-only:
dsh-commands, dsh-credentials, dsh-compaction, dsh-lsp, dsh-mcp-client…) that
must be built from the tag's source, subpath imports the loader can serve
once the package exists, and transpile-pipeline gaps for deep `src/*.ts`
imports. That is the owner's gap-fill loop, next rounds enumerated.

## Alternatives considered

- **Run the suite only under vitest (Node) and cite it** — rejected: the
  suite's entire value is what OUR runtime does with it; Node numbers were
  already green and prove nothing about the embedder.
- **Vendor rc versions of the unpublished packages to inflate the green
  count** — rejected: mismatched API surfaces fake compatibility; the gap map
  names the missing tag builds instead.
- **Drive the iOS leg through the carrier's runtime.config like Android** —
  rejected for this leg: the launch-env facts need zero carrier-side branching
  (the parity drive's proven shape), and device carriers keep their bus
  handoff untouched.
