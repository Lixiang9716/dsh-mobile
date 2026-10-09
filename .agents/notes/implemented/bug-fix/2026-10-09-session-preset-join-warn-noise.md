# The agent-presets publish warn is join-ordering noise — settled by a paired debug line, not a wiring change

Status: implemented
Related: T-0048

## Problem

Every session the page creates on a `presetJoin` seat logged the vendored
`cordis:agent-presets` warn: *"agent ... was published without joining an
agent preset; its tools, prompt sections, and skill catalog resolve against
the empty global layer"*. The symptom read as the T-0048 join not firing on
the user-facing path — which would mean every page-driven session answered
without the mobile preset's prompt sections. Whether the join actually
covered the system prompt was unproven: the warn fires from the vendored
`agent/created` listener **inside** `ctx.agents.create`, while
`joinCreatedSessionToDefault` runs immediately **after** the same call
(web-write.js), so the log alone cannot separate a covered session from an
uncovered one.

## Decision

Proven, not assumed: the new node leg
(`runtime/dsh/ci/run-session-preset-join-node.sh` →
`test/upstream-suite/session-preset-join.mjs`) boots the REAL mobile spine
under plain node with the preset-join seat's flag shape, drives the page's
own wire (`session/create` → `session/prompt`) against a loopback capture
server, and asserts on the request the model actually receives. Result: the
joined session's `composedPreset` is `mobile`, the wired system prompt
carries the mobile persona section, and the preset-only tool rows are in the
wire catalog; the flagless negative control stays on the empty global layer.
The warn is publish-ordering noise — the join covers every page-created
session on a `presetJoin` seat.

The fix is therefore observability, not rewiring: `joinCreatedSessionToDefault`
emits a debug line after the mount names the session and the preset it
composed from (`web-write` / "session preset joined"), so a log reader can
settle warn-vs-real from the pair alone. The node leg asserts that line
(leg C) and fails without it (verified by reverting the fix: exit 1).

## Alternatives considered

- **Silence or reorder the warn** — vendored bytes (D6 forbids edits), and
  the warn is TRUE at publish instant; suppressing it upstream would also
  hide the flagless-seat case where it is the real signal.
- **Join before publish** — impossible from our layer: the scope key to bind
  only exists after `agents.create` returns the agent handle; upstream's own
  remedy is the agent-factory `setup` hook, which the mobile profile does
  not implement.
- **Promote the paired line to warn/info** — release builds strip debug/info
  (rule L4), but a warn per healthy session creation would train operators
  to ignore warns; the PR carries the wire-level proof and the leg stays
  runnable, so debug is the honest level.
- **Add the missing creation-plugin createLogger guidance to the mobile
  preset's prompt sections (P6a tail)** — confirmed absent (the persona row
  is two lines; `agent-instructions` only pulls workspace AGENTS.md), but a
  preset-doc edit ripples through four embed syncs (harmony rawfile, iOS,
  android staging, the CLI seed) and deserves its own line; recorded as
  follow-up.
