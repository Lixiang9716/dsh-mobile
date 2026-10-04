# loop-u: an errored turn strands its queued followups — the mobile face had no recovery wiring

Status: implemented
Related: D9

## Problem

The r11 battery's V1 sessions died mid-turn with a shape nothing handled: an
assistant stream cut mid-sentence ("Why don", V1b), no closing prose, no
error anywhere in the UI, a session frozen at "1 turns 1/2 steps", and every
prompt queued behind the running turn silently dropped (session-f9a36f20:
marker counted 3 sends, the session ran 1 turn). The UI's "Retry terminal
recovery" banner is unrelated — it renders in healthy sessions too (V3's, on
the same evidence page).

Reading the turn state machine split the attribution in two:

- **Failed TOOL calls are not the trigger.** The vendored loop treats a tool
  error as an in-band `isError` result and continues (dsh-agent-loop
  lib/index.js:640-660; #356's refusals never leave the turn). Re-driven on
  the current build (emulator-5556, glm-5.3-flash): the /system/app prompt
  produced two in-band refusals and a full closing prose at 4 steps.
- **A dead LLM attempt is.** When the assistant stream finishes
  `{kind:'error'}`, the loop fires its `agent/request-error` waterfall
  (lib/index.js:1086) and, if nothing answers `retry`, throws `LlmError` —
  the turn ends `reason:{kind:'error'}` (turn(), lib/index.js:958-973) and
  `kick()` swallows it (lib/index.js:872-880). The driver's re-arm needs
  `wakeRequested && inbox.hasPending`, but `wakeRequested` only latches for
  messages arriving AFTER the abort signal fired (send(), lib/index.js:788)
  — a followup queued behind a healthily running turn (the normal V1
  choreography) never latches it. Result: errored turn → idle → stranded
  inbox. Healthy turns avoid this because `turn()` itself returns true while
  the inbox has pending work (lib/index.js:1000-1004) — the V3 contrast.
  And nothing surfaced the failure: the client renders journal MESSAGES, an
  errored turn appends only lifecycle events, and the mobile compose had
  zero `agent/error` subscribers (the desktop controller relays it to its
  API face — dsh-api-session-controller lib/index.js:2727).

Device reproduction on the current build: a mid-stream airplane-mode kill
left the turn frozen at a truncated "Why don" with no error and no progress —
the r11 shape, deterministic.

## Decision

Two mobile-layer wires, no vendored edits:

1. **Mount the vendored `@deepseek-ai/dsh-llm-retry` plugin** (boot.js
   `mountRecoveryRings`, after the loop/watchdog). It answers
   `agent/request-error` with the provider's retry policy — which the llm
   service's `prepareCall` already attaches with normal-mode defaults (5
   retries; EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT) — so a
   transient stream death retries the REQUEST in-turn. Most blips never
   become errored turns. The package is now PINNED (its
   `@deepseek-ai/dsh-llm-retry@0.1.6-alpha.2` registry tarball, sha
   69f1080b…, in ensure-dsh.sh's NPM_PACKAGES + the tracked mirror) — until
   this PR it existed only as an untracked dev-tree leftover, so every
   fresh checkout (all of CI) booted the spine straight into
   "no vendored dsh package serves it". Embed rows: android stages the
   npm face at the dsh rel path (the goal/file-reference loop), harmony
   carries it in the rawfile CLOSURE find + BUNDLE_FILES, iOS embeds the
   tree (the dsh-goal pattern, now a comprehension row).
2. **`upstream/turn-recovery.js`** (new, ring 2, mounted after llm-retry):
   marks an agent on `agent/error`; on its `agent/status` idle transition it
   appends ONE durable `system/message` ("Turn failed: <chain> — the queued
   messages continue next.") — visible in chat, which the lifecycle-only
   journal events never were — and re-arms the driver when the inbox still
   has pending work, so the queued followups run per the existing followup
   semantics. The re-arm calls the vendored face's `wakeDriver` (private in
   the .d.ts; the send()-with-wakeup alternative would have to insert a
   synthetic user message) guarded by a typeof check that degrades to a loud
   warn on a pin drift.

Panel pins (test/panel/turn-recovery.test.js, 9 cases): the errored-turn +
queued-followup contract (one honest note, driver re-armed), no-pending and
healthy-idle negatives, one-note-per-turn, loud degrade without wakeDriver,
loud mount without the registry, and the vendored llm-retry behavior itself
(retryable failure → durable `llm/retry` + `retry` decision; non-retryable →
pass-through).

## Alternatives considered

- **Treat failed tool calls as the trigger** (the queue row's hypothesis) —
  refuted by the code path (in-band isError results) and by the device
  control run; a fix there would have "fixed" a healthy path.
- **Re-arm by following up a synthetic user message** (the only public
  send-based wake) — rejected: it writes a fake user turn into the durable
  journal to do what the driver's own entry does.
- **Supervisor re-arms on every idle** (not only errored ones) — rejected:
  it would fight cancel-with-keepInbox semantics (the user's explicit stop
  must keep the queue until the user resumes).
- **Auto-retry the whole TURN on error** (second supervisor returning
  `retry` from the request-error waterfall) — rejected: unbounded work on a
  deterministic failure; llm-retry's budgeted policy is the upstream answer.

## Consequences

- A transient provider blip now rides out in-turn (the device re-verify: a
  mid-essay airplane-mode kill completed at 00:16 with the UI showing
  "Retrying model request (1/5)" instead of a frozen half-sentence), and a
  turn that still fails closes with an honest visible note while its queued
  prompts continue.
- Known residual, filed as loop-u2: the mobile llm transport arms NO attempt
  deadline, so a black-hole socket (the radio off while an attempt is
  in-flight) can hang the attempt with the retry banner frozen — the abort
  plumbing exists (llm-transport.js:214/314), nothing schedules it. The
  watchdog cannot unwind that await (its own documented limit).
- On-device iteration note: `install -r` does not refresh `files/spike`
  (names-only asset stamp); remove the tree after reinstall.
