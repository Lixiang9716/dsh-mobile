# Upstream-suite growth round 1: the src-tree extraction (229 → 671 specs) + the shim self-test in CI boot

Status: implemented

Date: 2026-09-25 · Class: testing · Follows: the upstream-suite gap-fill
note of the same day (bug-fix class).

## Problem

The first full sweep ran 262 specs — but the upstream monorepo's tests
number in the thousands, and the transpile pipeline's exclusion census hid
where the ceiling actually was: 468 specs sat in an opaque "esbuild
transform failed" bucket with no reason recorded (a `catch {}`), and the
inclusion set itself (229) was a fraction of what the vendored test tree
could support. The owner's direction: support more specs, even on mobile.

## Decision

Three changes:

- **`ensure-dsh-tests.sh` extracts the packages' `src/` trees** (same
  codeload tarball, same sha256 — only the filter widens; D6 unchanged).
  The 468-spec bucket was ONE class: specs importing their package under
  test through the relative monorepo spelling (`../src/index.ts` — upstream
  runs its suite from source), unresolvable when only `tests/` was
  extracted. Transpiled set: **229 → 671**; total exclusions 625 → 218
  (what remains: vi.mock loader interception 64, bare src/ subpaths of
  OTHER packages 52, decorators, node:vm, FiberState, wall-clock mocking —
  all named classes).
- **The same script's extraction was silently broken locally**: BSD tar
  (macOS) has no `--wildcards`, and the `|| true` masked it — local runs
  produced an EMPTY tree while CI's GNU tar worked. Now: gtar when
  present, else a python3 tarfile pass applying the same patterns; an
  empty `packages/` tree fails loud.
- **`transpile.mjs` records the transform-failure reason** per bucket
  (rule 5: a swallowed bundle failure hides the missing-dependency map,
  which is the whole actionable surface of that bucket).
- **CI wiring**: `boot-verification` gains a `shims.selftest` phase — the
  four regression faces the sweep distilled (TextDecoder non-fatal decode
  with multibyte, Buffer single-byte family, fileURLToPath relative
  resolution, fs/promises rmdir+symlink link surface) asserted on every
  CI boot (iOS + Android run this scenario today), one structured event,
  one manifest expectation. 8/8 green on the CLI.

The promoted sweep re-ran over the enlarged set: **green 119 → 261,
5730 tests passing / 883 failing** on the QuickJS leg. The new gap map's
head: `node:events` shim (~26 specs waiting — pure JS, product surface),
`node:http` (~29 — a real client seam over the gateway, a project of its
own), runner-launch desktop chunks (27 — structurally out), chokidar (18
— the fs-event seam, still out), npm test faces (zustand/eventsource-
parser/react — a closure-policy decision, not a shim).

## Alternatives considered

- **Wiring the sweep itself into CI as a gate**: rejected (again) —
  ~40% of the enlarged set is structurally red by architecture; the sweep
  stays the promoted local diagnostic, and the CI net is the always-green
  self-test distilled from its findings.
- **Bridging react/zustand/eventsource-parser as npm faces** so their
  specs load: deferred — that grows the pinned runtime closure with
  test-only dependencies, a closure-policy decision above this round.
- **Hoisting more bare `src/` subpaths** onto the submodule (the existing
  curated SUBMODULE_SRC_HOISTS mechanism): unnecessary for the relative
  class the extraction fixes; the curated map stays for its two entries.

## Consequences

Every PR's device boot now re-proves the distilled shim faces. The sweep's
baseline for the 0.1.7 re-pin is the 671-spec set — the report's gap
clustering re-derives against the new closure then. Next round by ROI: the
`node:events` shim, then the preset-family fixture staging (the transpile
pipeline decision this round's data makes concrete).
