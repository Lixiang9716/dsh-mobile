# Agent Note: the driver/presentation Node-testable faces carry real line coverage — and the suites caught two port bugs

Status: implemented

## Problem

The repository's classical line coverage was zero (no coverage config
anywhere), and the honest coverage story was upstream specs + e2e evidence
rows + gov gates. The commissioning ask: the #248 precedent ("vitest catches
real bugs" — real local http server + real ws upgrade, no fetch mocks) had
proven itself on the lynx-client seam/wire tests but had not been extended
to the rest of the Node-testable product surface: the driver loop's own 18
checks lived only inside a self-executing script (`run-mock.mjs`), the
never-imported modules (`driver.js`, `skin-stub.js`, `mock-serve.mjs`,
`skin-lynx.js`) sat at 0% and invisible (not even reported — nothing
imported them), and web-client-next — the ORIGIN of the wire protocol, the
mux state machine, and the journal fold — had no tests at all. The risk was
asymmetric: `web-client-next` is the page real users load; a regression
there ships to the browser.

## Decision

- **lynx-client**: `tests/driver-loop.test.js` formalizes run-mock's 18
  checks 1:1 (same names, same assertion substance) as vitest cases over
  the SAME real pair — in-process mock-serve on loopback HTTP+WS, real
  wire client, real driver, stub skin — plus edge legs the runner never
  had (submit with no session, follow of an unknown session → error frame
  → honest status + follow left, a session/create answer without a
  sessionId → fail loud, mock endpoint guards not-found/busy, the lynx
  faces' artifact verification + no-engine wall). `tests/wire-edge.test.js`
  covers the envelope's malformed-answer legs (missing rpcId, result with
  no ok arm, ok:false with no error object, non-JSON body, HTTP 404) and
  the payload-KEY-present guard. `tests/mux.test.js` drives the driver mux
  over real RFC6455 sockets (server half = the carrier's own ws-lite).
  `vitest.config.js` includes the never-imported modules so the number is
  honest about what exists; the two self-executing runners are excluded —
  their checks ARE the driver-loop suite now. Before → after (same config,
  all files lines): 50.87% → 91.15% (driver group 26.64% → 87.5%).
- **web-client-next**: a test suite at `test/web-client-next-suite/` (`npm
  test`) with three files: `tests/wire.test.js` (the api.js envelope over a
  real local HTTP server; the one browser-only byte — the relative `/api`
  URL — is shimmed with a base prefix, everything else byte-for-byte),
  `tests/mux.test.js` (the page mux over real sockets; only `location` is
  provided; Node 24's native WebSocket is the same WHATWG surface the
  browser ships), and `tests/timeline.test.js` (the journal fold: every
  event family, the streaming tail accumulate→promote, snapshot/seed
  rebuilds, the two-tier notifications). The coverage config includes the
  browser-only files at their honest numbers (main.js / render-*.js /
  composer.js / markdown.js stay 0 — no jsdom theater; the DOM faces are
  reported as out of scope, not faked). Node-face lines after: api.js
  100%, mux.js 97.46%, timeline.js 95.5%.
  **The suite deliberately does NOT live in `presentation/web-client-next/`**:
  that directory is WHOLE-TREE staged into the harmony HAP rawfile
  (`vendor-official.sh` `webclient_files` find()s every file), and
  check-bundle-files reds on anything the HAP cannot carry — an in-place
  `npm install` there sweeps node_modules (and vitest's cache/coverage
  artifacts) into the app's payload (observed live: hidden-file violations
  for `webclient/dsh-web-client-next/node_modules/.vite/...`). The suite's
  vitest config pins the product directory as root (coverage can only
  include files under root) while pinning BOTH artifact sinks — the vite
  cache and `coverage.reportsDirectory` — back into the suite's own
  directory, so a test run, plain or `--coverage`, leaves the product
  tree at its 12 shipped files (asserted by the gate runner on every
  run). The v4 key is `reportsDirectory`; an earlier draft used
  `outputDir`, which vitest silently ignores — observed live as an HTML
  report inside the staged product directory.
- **Falsify-then-restore discipline** held for every new suite: the mock's
  cancelled turn/end dropped → cancel leg red; api.js's rpcId guard
  removed → wire-edge leg red; the fold's cancelled-tail drop removed →
  timeline legs red; mux reconnect scheduling removed → reconnect leg red;
  the payload default removed → payload-KEY leg red. All restored green.

**Two real bugs the suites caught, both fixed in their own commits:**

1. `presentation/lynx-client/driver/wire/mux.js` (fix commit `de915775`):
   the port of web-client-next's mux dropped the `++` in
   `const generation = ++this.generation` per connect() — the instance
   generation guard was dead code, so a superseded socket's late close
   passed the check, emitted a spurious `closed` and dialed a duplicate
   third socket (both then re-open every live stream). Hidden in plain
   sight because the module-level `diag.generation` counter still ticked.
   Red proof captured in-session (3 upgrades instead of 2); the same leg
   is green on the page original.
2. `presentation/web-client-next/web/js/timeline.js` (fix commit
   `6ddb32bf`): `recordInterruptedCalls` passed `block.arguments` through
   raw, so an interrupted tool-call block without an arguments field
   leaked `args: undefined` into the fold, where the renderer's
   `item.args !== ''` branch rendered a ghost args row. Every other fold
   path normalizes (`applyToolCall`: `data?.arguments ?? ''`; the lynx
   adapter: the typeof-string ternary); this one now does too.

## Alternatives considered

- **Import the runners in tests instead of formalizing their checks**
  (spawning run-mock.mjs as a child process and asserting exit 0): keeps
  one source of checks but yields zero module-level coverage, keeps the
  15s-deadline shell as the only green criterion, and cannot express the
  edge legs (the runner has no legs for stream errors or bogus creates).
  Formalizing 1:1 keeps the runner as the standalone loop evidence AND
  makes the same behaviors `npm test` citizens.
- **jsdom for the browser-only faces** (composer/render-chat/markdown):
  tests the DOM library more than the product, and the ask's boundary —
  browser-exclusive faces are honestly out — says report them at 0
  instead. markdown.js's parse half is pure and COULD be covered by
  exporting it; not done here because the file deliberately ships no
  such export and changing product code to feed coverage is the
  tail wagging the dog (recorded as the natural follow-up, with the
  renderer, in one dedicated change).
- **A single repo-root vitest workspace** covering both packages: the two
  packages are deliberately self-contained products (the lynx-client is
  "wholly replaceable — the directory is the product"); per-package
  configs keep that property and keep `npm test` meaningful inside each
  directory.
- **Snapshot tests for the stub-skin transcript**: brittle against
  wording, and the 18 checks already assert on stable markers;
  transcription snapshots would test the transcription, not the loop.

## Consequences

`npm test -- --coverage` in each package is now the honest driver/presentation
line-coverage surface; the numbers live in PR descriptions and this note,
the raw report stays a local artifact (coverage/ is gitignored in all
three locations, including a belt-and-braces entry for the staged product
directory). **Both suites are wired into the gates DAG as the
`presentation-tests` gate** (`gates.json` → `tools/test/run-presentation-tests.sh`,
scoped to the three directories plus the runner itself), so the port-bug
class this note records now fails `gov run` locally AND the CI `gates` job
— the runner re-asserts on every run that the staged product tree holds
exactly its 12 shipped files. `tests/mux.test.js` on both sides is the
contract that pins it.
