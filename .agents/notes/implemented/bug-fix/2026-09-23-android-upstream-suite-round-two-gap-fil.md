# Agent Note: android upstream suite round two gap-fill

Status: implemented

## Problem

Round two of the upstream DSH suite on the Android emulator (dsh-v0.1.6-alpha.2,
one spec per app launch through `hosts/android/ci/run-upstream-suite.sh`) left
spec-file failures and hangs whose causes were not named:

1. `cannot load module '@deepseek-ai/dsh-ptc-runtime'` (2 specs) although the
   package was staged under assets — the loader's generic dsh- map strips the
   `dsh-` prefix (`@deepseek-ai/dsh-ptc-runtime` → `vendor/dsh/ptc-runtime@…`),
   but the test closure's npm tarballs keep their LITERAL directory names
   (`vendor/dsh/dsh-ptc-runtime@…`). Two staging families coexist in
   `vendor/dsh/`: the spine closure's stripped names (`session@`, `llm@`) and
   the test closure's literal ones. The map could only serve the first family,
   so every literal-family package (ptc-runtime, typert-registry,
   agent-loop-testkit, …) was unloadable — while looking perfectly staged.
2. `cannot load module 'vendor/dsh/dsh-session@…/lib/invariant.js'` (3 specs)
   — the transpiler's esbuild plugin rewrote `@deepseek-ai/dsh-<pkg>/<sub>`
   subpath imports into bundle paths using the literal dir family (wrong for
   every spine package), appending `.js` blindly and forcing a `lib/` prefix
   that matches neither `lib/types/<sub>.js` exports shapes nor imports that
   carry their own `.js` suffix (`…/types.js`).
3. Hang-class entries (300s runner timeouts): an awaited promise that never
   settles once a spec's flow arms a deadline/watchdog through
   `@deepseek-ai/dsh-timeout` — which calls a bare global `setTimeout` the
   runtime deliberately does not have.
4. Harness-API gaps: `vi.spyOn(…).mockImplementationOnce` ("not a function"),
   `.resolves.not.<matcher>` (the async chain had no `.not` — "cannot read
   property of undefined"), `toContainEqual` with nested asymmetric matchers,
   `expect.fail/soft/unreachable`, `vi.isMockFunction`.
5. Quickjs-parse and layout impossibilities surfaced as on-device noise:
   decorators (`@Remote`) that quickjs-ng 0.17 cannot parse (esbuild passes
   ES decorators through verbatim), `vi.spyOn` on `import * as` namespaces
   (ESM bindings are read-only — only vi.mock's loader interception can do
   it, an already-excluded class), monorepo `src/` subpaths the published
   tarballs don't ship, `FiberState` missing from the pinned cordis@4.0.2,
   and `createRequire(import.meta.url)('../package.json')` reads that
   presume the monorepo layout (the tests codeload tarball carries no
   package.json at all).
6. The suite driver and harness exist as TRACKED APK ASSET COPIES
   (`assets/spike/scenario/upstream-*.js`) that copyAssetDir re-merges over
   filesDir on EVERY launch — silently clobbering any runner-pushed copy.
   Round two's first batch ran with a stale harness for exactly this reason:
   the runner staged fixes that the APK's old copies overwrote at boot.

## Decision

- The C loader's generic `@deepseek-ai/dsh-<pkg>[/<sub>]` map returns a
  marker (`DSH_MAP_VENDORED_PROBE`) and one probe (`dsh_vendored_rel` in
  `runtime/spike/host/dsh_spike_host.c`) resolves BOTH directory families
  against the exports-map file shapes the dsh build actually ships
  (`lib/<sub>[.js]`, `lib/types/<sub>.js`, stem variants for `.js`-suffixed
  imports, `lib/index.js` for bare), failing loud naming the specifier when
  nothing opens. The node:module require seam (`__dshBundleRequire`)
  resolves through the same probe — one resolution site. The dsh-llm
  subpath table keeps its non-derivable aliases (typert → typert.host.js),
  gains `brand`, and falls through to the probe instead of erroring; the
  obsolete "types is type-only" guard is gone (dsh packages ship runtime JS
  under lib/types/).
- The transpiler (`test/upstream-suite/transpile.mjs`) leaves every
  `@deepseek-ai/*` import BARE — the loader probe owns subpath resolution,
  so the two-family problem has one implementation instead of two. The
  UNIMPLEMENTED scan also runs on the BUILT OUTPUT (esbuild bundles local
  helpers whose imports never appear in the spec source — a whole vi.waitFor
  population hid there), and gains named rules: expect.poll, decorators,
  monorepo src/ subpaths, FiberState-from-cordis, and vi.spyOn-on-namespace
  (per-spec, computed from that spec's `import * as` names).
  `createRequire(import.meta.url)('<relative>.json')` is rewritten to a
  bundled JSON import resolved against the vendored package when the tests
  tree lacks the file. Corpus: 524 transpiled / 325 excluded, all counted
  with named reasons; the whole corpus parse-checks clean under the vendored
  quickjs (verified with a one-off local probe binary, not landed).
- The harness (`runtime/spike/scenario/upstream-test-harness.js`) grows the
  `mockImplementationOnce` family (one-shot queue ahead of the standing
  implementation), `vi.isMockFunction`, `expect.fail/soft/unreachable`,
  matcher-aware `toContainEqual`, and a lazy `.not` on the resolves/rejects
  async chain. `runCollected` emits a `test/start` per test — a hang now
  names the exact test it froze on in the stream.
- The suite driver + harness are staged into the APK assets BY
  `stage-spine-closure.sh` from `runtime/spike/scenario` (single source,
  byte-identity-checked in `--check` mode), and the runner no longer pushes
  its own copies (they were clobbered by the asset merge anyway). The
  runner also wipes the corpus dir before extracting (a regenerated corpus
  leaves no uncounted stale specs), skips double-counting timed-out specs,
  and waits a beat longer after `ALL` before killing the logcat streamer
  (long summary lines were being cut mid-write).
- The timer seam the failures point at (the `setTimeout is not defined`
  family, the hang class, the fake-timer/waitFor/poll exclusions) is
  proposed as a contract addition —
  `contract/proposals/timer-primitive.md` (`timerSchedule`/`timerCancel` +
  `timer.fire` event channel, `timer` permission flag, bilingual pair) —
  NOT implemented; no global setTimeout exists or is added anywhere.

## Alternatives considered

- **Fix the transpiler's subpath rewrite instead (exports-map-aware, both
  families).** Rejected: two resolution implementations (JS rewrite + C map)
  must agree on directory naming — the exact drift that caused failure 2.
  With the loader probing both families there is one site.
- **Rename the test closure's vendored dirs to the stripped convention.**
  Rejected: `vendor/` trees are materialized verbatim from pinned tarballs
  by ensure-dsh-tests.sh (D6 upstream discipline); renaming adds a divergence
  the next re-pin erases.
- **Stage the harness from the runner (adb push).** Rejected: the tracked
  APK asset is re-merged over filesDir on every launch — only shipping the
  fix IN the asset (via stage-spine-closure.sh) makes it stick. Discovered
  the hard way: round two's first batch silently ran a stale harness.
- **Strip decorators at transpile.** Rejected: `@Remote`/`@RemoteScope`
  carry runtime registration semantics these host-spec controllers exist to
  exercise; silently dropping them would fake coverage. Named exclusion.
- **Implement the timer seam in this round** (global setTimeout, host timer
  pump, or timers shim behavior). Rejected: contract-first (D5) — a host
  callback surface lands only after the primitive row is frozen; the
  proposal document carries the design and the evidence instead.
- **Soft-collect `expect.soft` failures to end-of-test** (vitest's real
  semantics). Rejected for now: the harness has no per-test failure
  collector and the verdict (fail) is identical; approximating as an
  immediate assertion keeps the harness small and is documented in the
  harness source.
