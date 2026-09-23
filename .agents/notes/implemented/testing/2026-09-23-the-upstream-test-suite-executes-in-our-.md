# Agent Note: the upstream test suite executes in our runtime — the quickjs-shaped harness and the transpile pipeline

Status: implemented

## Problem

The owner's direction for the port: run DSH's FULL test suite (unit,
integration, e2e) inside OUR environment on the emulator, treating every
failure as a named gap to fill — not a hand-picked scenario subset and not
log-shape assertions. Upstream's suites are vitest/TypeScript running under
Node; our runtime is quickjs with no Node test toolchain, no TS, and its
own module loader — so upstream's tests could not execute as-shipped
anywhere on our side.

## Decision

A two-stage pipeline lands. (1) The Node-side PREPASS
(test/upstream-suite/transpile.mjs, esbuild): each upstream spec becomes
plain ESM with package imports left BARE — the quickjs host loader resolves
them to the vendored closure, so the tests exercise the exact bytes we ship
— local fixtures bundled in, and the `vitest` import rewritten to our
harness. Specs whose vitest API exceeds the harness subset (vi.mock and
friends, fake timers, expect.extend) are excluded with a named reason and
counted (667 transpiled, 187 excluded at 0.1.6-alpha.2). The test assets
themselves are materialized at the SAME TAG as the closure
(vendor/ensure-dsh-tests.sh: one sha256-pinned codeload tarball for the
test trees + 192 npm-pinned packages forming the test closure, physically
separate from the runtime closure). (2) The quickjs-side TEST SHELL
(scenario/upstream-test-harness.js): describe/it/expect/vi implemented to
the corpus-surveyed surface (deep-equal toEqual, subset matchers,
asymmetric factories, spy-call matchers, lazy .not, resolves/rejects
chains, expectTypeOf as a symbol-safe permissive chain); anything
unimplemented fails LOUD naming the API — a silent skip would fake a green
suite. The on-emulator driver (scenario/upstream-suite-leg.js) loads one
transpiled spec over the bus config and streams per-test verdicts.
Pipeline proof: the flagship loop.spec passes 65/65 under the harness with
zero unhandled rejections — identical verdicts to real vitest; spot
smokes across agent/session run 152/154 (the tail: two known harness
iterations). The Node-side smoke (smoke.mjs) runs the same transpiled
artifacts through the same harness under Node — one pipeline, two hosts.

## Alternatives considered

- **Run the suite under real vitest against our vendored closure (Node
  only)** — rejected as the whole answer: it proves the closure under
  Node, not our runtime; the emulator leg is the point of the direction.
  (The vitest config for that landscape ships alongside as a diagnostic.)
- **Port vitest to quickjs** — rejected: vitest is a Node toolchain
  (esbuild, workers, Node APIs); porting it is a project dwarfing the
  port itself. The harness implements the ~20 APIs the corpus actually
  uses instead.
- **Skip-based compatibility (run until it breaks, disable the rest)** —
  rejected: exclusions are named and counted at transpile time; the
  runtime failure path names the missing API. Dark skipping is exactly
  the fake-green failure the plane's rules exist to prevent.
