# Agent Note: tool runs get a deadline; silent turns get a watchdog (#323)

Status: implemented
Related: #323, D6, D9

Date: 2026-10-03 · Class: bug-fix

## Problem

A real-LLM follow-up turn on the release seat (T-0167 battery, 2026-10-03
07:16) wedged the runtime for 10+ minutes: CPU pinned at 146% with a
byte-identical minor-fault count across 2.5 minutes (zero progress), the mux
heartbeat starved, and the page logged `connection lost`. The last visible
trajectory step was a `str_replace_editor · view` tool call; release builds
carry no debug logs (L4), so the exact spinning call is unnamed — but the
shape is not in doubt: the agent loop dispatches every tool body with a bare
`await tool.execute(...)` (vendored dsh-tools `dispatchToolBody`), the agent
loop itself arms no timeout, and on the serial QuickJS runtime any
never-settling or never-yielding tool call pins the one thread everything —
heartbeat, journal, page connection — depends on. The vendored
`@deepseek-ai/dsh-timeout` was pinned but guarded nothing on this path.

## Decision

Two JS rings on the mobile seat (`upstream/boot.js` mounts both):

1. **Per-tool deadline** (`upstream/tool-deadline.js`): a cordis plugin that
   registers a `tools/execute` waterfall listener — the registry's own
   around-dispatch extension point — arming a wall-clock budget (default
   120 s) with the vendored `dsh-timeout` `deadline()` around every native
   tool dispatch. The budget is fused into `exec.signal` before the body
   runs (cancellation-aware bodies are told to stop through upstream's own
   signal path); when the budget lapses first, the call fails IN-BAND in the
   registry's error-result shape (`isError` + `error.info.code:
   'tool/deadline'`), the turn continues, and the runtime stays responsive.
   An upstream cancellation aborting the same signal is not a timeout and
   keeps the registry's cancellation semantics.
2. **Turn watchdog** (`upstream/turn-watchdog.js`): a re-armable timer fed
   by every observable turn progress (session journal appends, assistant
   -stream frames, agent status); 300 s of silence on a running agent fails
   the turn in-band — the agent is cancelled with a `watchdog` cause
   (`keepInbox`, so queued user messages are not the casualty) and the loop
   unwinds at its next await boundary.

Honest limits, stated rather than smoothed over: both rings ride JS timers
on the runtime's serial queue, so a body spinning **synchronously** never
lets them fire. That class is only preventable at the spinning layer: wasm3
(the `wasmRun` interpreter, dsh_wasm.c `m3_CallV`) has no interruption or
fuel API in the pinned v0.9.0, and D6 forbids modified vendored copies — a
fuel cap needs an engine fork (the quickjs-fork precedent), left as the
issue's follow-up. On the seat that actually hung (Android) `wasmRun` has no
handler at all (calls fail `denied` fast) and gateway `fsRead` is size-bounded
(8 MB), so the unbounded-sync-spin exposure there is a JS body, which only an
engine-level interrupt could stop; every await-shaped wedge (gateway call the
host never settles, stalled LLM stream, stuck approval wait) is now banded.

## Alternatives considered

- **Fork wasm3 for a fuel counter now** — rejected this round: it re-creates
  the quickjs-fork machinery (repo, pin, re-vendor, three C builds) for an
  exposure the hung seat does not serve; recorded as the follow-up instead.
- **Run wasm3 on a worker thread with a timed wait** — rejected: it leaves a
  runaway interpreter thread burning a core forever (worse than an honest
  trap), and a thread-join seam in shared C for a device class that does not
  serve wasmRun is machinery without a user.
- **Wrap each mobile-authored tool's `execute` individually** (shell-wasm,
  shell-ish) — rejected: point fixes miss the vendored tool family (fs,
  str_replace_editor, todo, skill) and every future tool; the waterfall is
  the one seam every dispatch already passes through.
- **Only the turn watchdog** — rejected: 300 s is the right budget for
  whole-turn silence but far too slow to bound a single stuck tool call;
  the per-tool ring fails the call fast and the model can re-plan.
- **Patch dsh-tools to enforce the declared `timeoutMs`** — rejected: D6
  (upstream runs verbatim); the adaptations live outboard, and the waterfall
  exists precisely for this.

## Consequences

- Every tool dispatch now crosses one extra `Promise.race` and arms one
  timer; the E2E suites (mock route, 30 turn-soaks) stay green with budgets
  120 s/300 s — no legitimate measured tool run approaches them.
- A timed-out tool's body promise is abandoned (its result goes unread); the
  fused abort signal is the stop signal it gets. This mirrors upstream's own
  around-dispatch posture and is documented in the module header.
- The panel suite now provisions the vendored `dsh-timeout` from the tracked
  mirror tarball (`test/panel/provision-vendor.mjs`, vitest globalSetup), so
  the regression test (`test/panel/tool-deadline.test.js` — the #323
  spinner: never resolves, spins in synchronous slices) runs on fresh
  checkouts where the vendor trees are absent.
