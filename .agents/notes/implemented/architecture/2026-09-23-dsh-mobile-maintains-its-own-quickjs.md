# Agent Note: dsh-mobile maintains its own quickjs — the engine fork's one divergence

Status: implemented

## Problem

The upstream DSH test suite (dsh-v0.1.6-alpha.2, vendored by
ensure-dsh-tests.sh) could not pass on our runtime for a reason no shim could
honestly cover: `@deepseek-ai/dsh-util-values`' realm guard
(`hasIntrinsicConstructor`) string-compares a native function's
`Function.prototype.toString` against the single-line V8/JSC rendering
(`function Object() { [native code] }`). quickjs-ng renders native functions
multi-line indented (`function Object() {\n    [native code]\n}`), so on stock
quickjs-ng **every plain object failed the realm check** —
`snapshotJsonValue` returned `undefined` for anything, Session creation
rejected every header ("session header is not losslessly JSON-serializable"),
and that one string comparison gated the majority of the suite (loop.spec
1/65 on quickjs vs 65/65 under Node/vitest; measured identically on the macOS
CLI host and the iOS simulator).

The rendering string is unspecified by the language — engines legitimately
differ. The package is vendored verbatim (D6: never modify upstream copies),
so the fix could not live in the package. The owner directed the remaining
route: maintain our own quickjs repository.

## Decision

The engine pin moved from upstream quickjs-ng 0.17.0 (`6d46d07d`) to **our
fork, `Lixiang9716/quickjs`, branch `dsh-native-tostring`, commit
`98395e3`** — upstream 0.17.0 plus exactly one divergence:
`js_function_toString`'s native-function suffix renders the single-line V8/JSC
form. `runtime/spike/vendor/ensure.sh` pins the fork (commit + tarball sha256,
`PIN=0.17.0+fork-tostring`); when tracking a newer quickjs-ng, rebase the
branch and re-pin. The compatibility claim is filed where it belongs:
anywhere-labs/dsh-desktop#1157 (deepseek-ai/deepseek-harness has issues
disabled) — if upstream adopts an engine-portable guard, the fork can collapse
back to a tag.

Measured effect (same harness, same specs): loop.spec **1/65 → 63/65 on both
the macOS CLI host and the iOS simulator** (the two remaining failures need a
real `setTimeout` — the timer seam this runtime deliberately does not have);
suite-wide, green specs went **12 → 31** (plus 16 partial) alongside two
harness-level shims (`AbortController`, `structuredClone` — the WHATWG subset
the spine's cancellation and state-clone paths need, installed in the shared
`upstream-test-harness.js` so every host gets them from one file).

The landing also hardened the whole vendoring seam, engine and closure alike:
the quickjs tree gained the dsh closure's pin-stamp discipline (a restored
CI cache is verified against the stamp, never trusted on file presence —
measured on the harmony runner, where a presence-only check printed the new
commit id over a tree cmake then could not build), and the 29 pinned dsh
tarballs are MIRRORED under `vendor/dsh-tarballs/` (1.04 MB, sha256-checked
against the pin table on every use) — a cold checkout needs no network for
the closure at all, retiring the master-deletion/frozen-ref fragility that
reddened CI twice on 2026-09-23. The vendor DIRECTORY stays
`quickjs-ng/0.17.0` regardless of the pin's display suffix: every build file
hardcodes that path, and a suffix-coupled rename broke the harmony build
exactly once before the decoupling.

## Alternatives considered

- **Shim `Function.prototype.toString` from JS** — rejected: it would lie
  about a spec-visible behavior to the very code performing realm checks, and
  the guard exists to detect tampering of this exact shape.
- **Patch the vendored dsh-util-values copy** — rejected: D6 forbids modified
  vendored copies; the adaptation would resurface on every re-pin.
- **Wait for an upstream fix** — rejected as the only track: the suite is the
  owner's stated compatibility bar today; the fork keeps us unblocked while
  the issue (mirror #1157) asks upstream to accept both renderings.
- **Vendor unpublished-at-tag packages to unlock the rest of the suite** —
  deliberately NOT in this change: most of the 83 remaining missing
  specifiers are monorepo-internal packages with no 0.1.6-alpha.2 npm
  tarball (rc-only); vendoring mismatched rc versions would fake
  compatibility. That is the next gap-fill round, from the tag's source.

## Post-script (same day, evening): divergence 2 — the async-context engine surface

The fork's second divergence (branch head now `7c4ae18`) implements the
engine side of TC39 proposal-async-context: a per-runtime context value
(`JS_Get/SetAsyncContext`), snapshotted into every enqueued job and
restored around its execution, and — the semantically load-bearing half —
captured at promise-reaction ATTACH time (`JSPromiseReactionData` carries
it; the resolve-time enqueue hands it to the job, so a C host event
resolving a promise cannot steal the continuation's context). Probe-proven:
an AsyncLocalStorage store survives await AND host-event hops; the parity
differential stays golden-identical; the shim's Promise.prototype.then
patch retires (quickjs runs await continuations through the job queue,
never through the visible .then — measured with
scenario/als-shim-probe.js). ALSO RECORDED: #169's merge silently reverted
#163's fork pin in ensure.sh back to upstream quickjs — restored (at the
two-divergence head) in the same change; worth an eye on future merges.

## Post-script 2: the TC39 proposal face as an engine intrinsic (same night)

Divergence 2 grew its spec-conformant public surface:
`JS_AddIntrinsicAsyncContext` (wired into `JS_NewContext`'s chain) evaluates
a small source at context creation defining **AsyncContext.Variable
(get/set/wrap, name/defaultValue), AsyncContext.snapshot(),
AsyncContext.wrap(fn, snapshot?)** — the proposal's API, riding the engine
slot via now-engine-bound `__asyncContextGet/Set` (the host-side binding
retired; the context is a copy-on-write Map keyed by Variable instances).
Probe-proven end to end: the surface exists, get/set + defaultValue hold,
values cross await AND host-event hops, wrap/snapshot restore the captured
whole context (an outside snapshot sees its own world), async wrapped fns
carry the zone — parity stays golden-identical, loop.spec 65/65, the ALS
shim rides the same slot untouched. The fork head is now
`4153a1f` (pin: `0.17.0+fork-tostring+async-context+tc39`). This is the
shape an upstream quickjs-ng PR would take.
