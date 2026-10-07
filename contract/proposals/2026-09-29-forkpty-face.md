# Proposal: the forkpty face — an honest pseudo-terminal primitive (v1.9.0 candidate)

> **Status: DRAFT (D5 proposal — nothing frozen, nothing implemented).**
> English | [简体中文](2026-09-29-forkpty-face.zh.md)

## Motivation

The upstream suite measured this wall too, from the terminal side: the
node-pty family of specs (`api/terminal-controller` controller,
`subprocess/subprocess-local` shell-activity, `terminal/tool-terminal`
loader-composition) fails inside the vendored
`@deepseek-ai/dsh-subprocess-local` terminal path at its first real
require — `createLazyRequire("node-pty")("node-pty")` — because the frozen
contract exposes **no pseudo-terminal primitive**. The v1.5.0-era
subprocess seam (W5-R) gave the host real OS children over pipes; the
terminal path needs the same children on a real **PTY** — echo, job
control, a foreground process group, TERM, and a live window size — which
no pipe can carry.

The product pull is the same shape: an interactive shell tool (the bash
tool's real face) reads its child's prompt state through the PTY, and the
vendored shell-activity detector measures foreground process groups —
facts that only an honest terminal carries.

This proposal adds the **minimal audited pseudo-terminal seam**:
`forkpty`-class spawn, data and exit as an event sequence, the
write/resize/kill control face, everything through the gateway audit. It
deliberately does **not** fake TTY semantics over pipes — that alternative
was examined and rejected by the owner (decision matrix D-b, 2026-09-29):
a pipe-backbone shim would fabricate exactly the terminal facts the
terminal path exists to measure.

## The security model (five rules)

1. **One grant family, sibling to subprocess, not a copy.** The `pty` flag
   gates every call. A PTY child can do everything a piped child can plus
   terminal semantics, so the grant is its own capability: a profile may
   hold `subprocess`-class pipes without holding terminals, and holding
   terminals never implies the wider socket seam.
2. **Spawn discipline, no shell string.** The request carries an argv
   array (never a command line — quoting belongs to the caller's own
   shell), a working directory inside the authorized scopes where scopes
   apply, and an environment the host scrubs of credentials exactly like
   the subprocess face does. The host sets TERM and the window size — the
   caller never touches the tty device itself.
3. **Events, never polls (D8).** Data and exit arrive as an event
   sequence delivered onto the caller's serial queue. There is no
   blocking whole-result API and no poll-a-state call: a consumer that
   stops reading relies on the host's bounded kernel buffer and its own
   flow control (`pause`/`resume` is consumer-side delivery gating; the
   host keeps reading so the child never deadlocks on a full pipe).
4. **Everything through the gateway audit.** Every spawn, write, resize
   and kill logs one record (caller identity, permission verdict, outcome,
   byte counts for writes). Payload bytes are end-to-end; the audit
   carries metadata only — the same rule the subprocess and socket faces
   obey.
5. **Session-scoped lifetime.** A PTY lives as long as its opening
   session; the host reaps children and closes masters at teardown. A
   grant is never persistent state, and no PTY survives a checkpoint (D7
   carries sessions, never live children).

The test suite itself needs no prompts and no user interaction: the
grant arrives with the profile, and the forkpty face is the honest
backend the terminal path already expects.

## The primitive (one, plus one channel)

Additive per the v1.1.0–v1.5.0 rule: a `gateway@1` host without the face
answers `unavailable` per call, and negotiation keeps every current floor.

### `ptySpawn` — open one pseudo-terminal child (grant `pty`)

```ts
export type PtySpawnRequest = {
  argv: string[];                 // program + arguments, never a shell line
  cwd?: string;                   // inside an authorized scope where one applies
  env?: Record<string, string>;   // host-scrubbed; TERM is host-set from `term`
  cols?: number;                  // window size, default 80
  rows?: number;                  // default 24
  term?: string;                  // TERM name, default "xterm-256color"
};
export declare function ptySpawn(request: PtySpawnRequest): Promise<
  { ptyId: string; pid: number } | null>;
```

Spawns the program on a fresh pseudo-terminal (the `forkpty` class:
openpty + fork + setsid + controlling tty + stdio on the slave side).
Resolves once the child is spawned; resolves `null` on user refusal of
the grant; rejects `denied` when the `pty` flag was never negotiated.

The control face is three calls, each audited:

- `ptyWrite(ptyId, bytes)` — keystrokes into the master side;
- `ptyResize(ptyId, cols, rows)` — `TIOCSWINSZ` on the master, which the
  kernel delivers to the child as `SIGWINCH`;
- `ptyKill(ptyId, signal?)` — one signal to the child; omitted signal
  means `SIGHUP` (the node-pty default the vendored path is written
  against).

### The `pty.event` channel (the v1.6.0 event-channel seam)

One channel per PTY, carrying:

- `{ ptyId, kind: "data", bytes }` — the child's output, one event per
  chunk, decoded by the consumer;
- `{ ptyId, kind: "exit", exitCode, signal }` — published exactly once
  when the child is reaped; `signal` is `0` for a normal exit.

No polling anywhere (D8); the events dispatch onto the serial queue like
every host event (D2).

## What v0 deliberately excludes (named non-goals)

- **Windows ConPTY**: the upstream node-pty carries a ConPTY backend; v0
  is POSIX `forkpty` only. A Windows host answers `unavailable` honestly.
- **Terminal emulation itself**: rendering rows to pixels is the Web
  Client's business (the xterm family stays client-side); the host moves
  bytes and window sizes, nothing more.
- **The master-fd `open` face**: node-pty's `open()` shares the raw fd;
  v0 keeps the fd host-owned behind the id.
- **Terminal multiplexing**: no tmux-style sessions, no detach/attach, no
  scrollback storage — a PTY is a live child, not a service.
- **Signal relay beyond `kill`**: job-control signals the child sends
  itself flow through the kernel; the host forwards nothing.

## Alternatives considered

- **Pipe-backbone shim (status quo + fake TTY)**: rejected by the owner
  (decision matrix D-b, 2026-09-29) — echo, job control and the foreground
  process group do not exist over pipes, so the shim would fabricate the
  terminal facts the shell-activity detector measures; the suite would be
  green against semantics that are not there.
- **ishRun guest terminals**: complementary, not a substitute — a guest
  terminal lives inside the emulated Linux userland (its own pty driver,
  its own lifetime); this proposal serves real-host children the way the
  subprocess seam already does.
- **No primitive (stay excluded)**: rejected — the three spec families
  fail at their first real terminal spawn, and the product's interactive
  shell face stays impossible; exclusion is honest today but it is a
  named gap, not a landing place.

## Verification plan

- The face's first deliverable is the suite itself: the three
  node-pty-family specs re-enter and verify green one by one on the
  darwin CLI leg (`upstream-suite-leg.js --env DSH_UPSTREAM_SPEC=...`,
  `suite/summary failed:0` for each).
- The dsh implements the seam on Darwin (`forkpty(3)` from
  `<util.h>`); the Linux-family hosts compile the same face from
  `<pty.h>` and keep it available, so capability negotiation never has to
  branch by platform — the same code path, honestly absent nowhere it
  compiles.
- Negotiation floors: hosts that do not compile the face answer
  `unavailable` until implemented; no current behavior changes.

## Version

v1.9.0 candidate (additive: one primitive + one event channel; the grant
family reuses the v1.5.0 family-flag mechanism). The numbering follows
the frozen v1.5.0 fold and the draft candidates: event channel v1.6.0,
render surface v1.7.0, socket seam v1.8.0.
