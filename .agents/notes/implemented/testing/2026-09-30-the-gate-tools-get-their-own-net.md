# Agent Note: The gate tools get their own net — the tools face under test and real line coverage

Status: implemented
Related: T-0078; the staging verifier/generator pair (P2), the code-size gate, the dev-web-carrier /plugins mux

## Problem

The repo's classic line coverage was zero — no coverage configuration
existed anywhere (the only vitest config, test/upstream-suite's, carries no
coverage section). The real coverage net was behavioral: 681 upstream specs
over the QuickJS runtime and the shims, the e2e evidence lines, and the 19
gov gates. The tools that gate every landing sat on the wrong side of that
net: check-staging, gen-staging-manifests, check-size.py, and the dev
carrier's /plugins mux had never been executed against a case that proves
they catch what their headers claim. The gap was not hypothetical — the
suite's first pass found three real bugs in shipped tools (below), and the
real repo checkout itself carries a live, undetected round-trip drift.

## Decision

test/tools/ is now a standalone runner package (the test/upstream-suite
convention): `npx vitest run` for the .mjs faces (52 tests, colocated as
`tools/*.test.mjs`), `python3 test/tools/check_size_test.py` for the python
face (stdlib unittest; pytest collects the same file).

The staging tools are exercised against HERMETIC fixture repos: the real
tool sources are copied verbatim into a tmp repo surrounded by minimal,
parser-compatible manifests (Index.ets BUNDLE_FILES, vendor-official.sh's
CLOSURE accumulation + $() find spans, stage-spine-closure.sh's six for-in
lists, gen_bundle_header.py's RESOURCES/TREES/ZOD_FILES shapes). Every
counterexample is a tmp-only mutation — no test mutates the repo. The
known capture classes are pinned as regression tests: the fresh-install
gap (a closure file the manifest misses), stale rows, broken first-party
edges, MISSING ROOTS, advisory-vs-verdict surfaces, the stage/verify twin
drift (captured live on main as `scenario/ble-plane.js` during this task),
the zod quadruple drift, the size gate's comment-state machine (#340), the
indent-fallback ruler (#342), the untracked-widening (#338), and the mux's
rev framing / graph-rev parity.

Coverage is a TWO-PASS runner (test/tools/coverage.sh) because vitest 4's
v8 provider never exposes NODE_V8_COVERAGE to the test tree (probed), so
no single tool attributes both the in-process imports and the spawned CLIs:
pass 1 (vitest provider) covers plugins-route.mjs (100% lines) and the
fixture helper; pass 2 (c8 over a preset NODE_V8_COVERAGE) covers the five
staging-tool files through the real child executions (94.91% lines
aggregate). Before: 0% by absence of any configuration.

Three bugs the tests caught, each fixed in its own commit and verified
against the vendored upstream (D6 parity):
1. gen-staging-manifests' zod `copiesAgree` was subset-only — a hand copy
   MISSING a row passed the agreement check (union size never notices a
   removal). Verdict-neutral on today's repo; the sibling-copy drift class
   is now visible. (69bb6847)
2. plugins-route's prepareSource could not strip trailers behind a trailing
   newline — the normal build output — diverging from the vendored
   dsh-client-modules' $-anchored trailer regexes on every real bundle.
   (0986893a)
3. plugins-route's serveSingle dropped the leading '?' of `?rev=` while its
   only caller passes url.search — the contract-2.5 single face and .map
   identity map answered 404 to EVERY request in the dev carrier. Upstream
   compares pathname+search against the same '?rev=' spelling. (fd70be8e)

## Alternatives considered

- Running the staging tools against the REAL repo in tests: rejected as the
  primary strategy — the blocking gate's verdict depends on the materialized
  vendored closure (CI provisions it; a fresh checkout is red), and testing
  verdicts against a moving repo state makes the suite flaky by
  construction. The fixture pins semantics; real-repo legs pin only
  checkout-independent behavior (warn mode, usage errors, verdict-runs on
  a prepared checkout).
- vitest --coverage as the single coverage command: probed and rejected —
  the provider does not propagate NODE_V8_COVERAGE to spawned children, so
  the fixture-executed tools (the majority of the face) would report 0%
  despite 52 tests executing them. c8 alone is the mirror image (workers do
  not dump). Two passes, one script.
- Fixing the single-face 404 by stripping '?' in the carrier's request
  construction instead: rejected — the carrier already passes the standard
  url.search; upstream's own comparison includes the '?'; serveCombo's
  defensive strip stays for the query-only face.

## Consequences

A tools-face regression now has a named failing test, and the face carries
real line coverage with an honest boundary: the dev-carrier server modes
(dev-carrier.mjs, next-mode, compose-boot, ws-lite) are excluded from
coverage by decision (server-at-import, unexported WS mux, live-fixture
faces) and remain owned by the e2e drives. Follow-ups: the live
`scenario/ble-plane.js` twin drift on main needs the android verify list
completed (or the scenario unstaged); the Kotlin/Swift/ets carriers were
not audited for the serveSingle '?' slip; a sibling-only zod drift is
reported (copiesAgree: false) but does not freeze — whether it should is
the owner's call.
