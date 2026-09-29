# Proposal: the socket seam — audited loopback networking with capability-graded scopes (v1.8.0)

> **Status: ADOPTED (2026-09-30, decision matrix D-d) — frozen additively as
> contract v1.8.0; v0 ships LOOPBACK ONLY.** The wider scopes (`lan`,
> `any-remote`) and TLS termination remain named non-goals with their own
> grant classes; the frozen shapes live in
> [primitives.md](../primitives.md) §4 "the socket seam (v1.8.0)".
> English | [简体中文](2026-09-28-socket-seam.zh.md)

## Motivation

The upstream-suite program (T-0070) measured the wall precisely: **18 specs are
excluded for one reason only — the frozen contract exposes no socket
primitive** (`ssh/ssh` 8, `lsp/lsp-stdio` 5, `ssh/subprocess-ssh` 5). The
v1.5.0-era subprocess seam made the host own real OS children; those children
(_real LSP clients, spawned test servers_) now need **real TCP loopback** to
talk to in-test servers — the in-process loopback dispatch cannot carry
traffic between two OS processes.

The product pull is the same shape: an LSP integration, an MCP-over-TCP
transport, or a webhook receiver are all "open a door, talk, close the door."

This proposal adds the **minimal audited socket seam**: loopback TCP only,
capability-graded, gateway-audited. It is deliberately **not** a general
network capability — see the security model and the named non-goals.

## The security model (five rules)

1. **Direction grading.** `connect` (outbound) and `listen` (inbound — the
   host opens a door) are different grant classes. `listen` is strictly more
   dangerous and is gated harder.
2. **Three scopes, default narrowest.** `loopback` (127.0.0.1 only) →
   `lan` → `any-remote`. v0 ships **loopback only**; the wider scopes are
   named non-goals with their own grant classes.
3. **Grants from three sources**, reusing the v1.5.0 family-flag mechanism:
   the installing profile declares what it needs (manifest, like a Chrome
   extension), out-of-scope calls raise a runtime prompt (like Deno's
   `--prompt`), and the user can review/revoke per profile in settings (like
   iOS local-network).
4. **Everything through the gateway audit.** Every `listen`/`connect`/accept
   logs one record (peer, direction, grant source, byte counts). Payload
   bytes are end-to-end (TLS pass-through stays intact); the audit carries
   metadata only.
5. **Session-scoped by default.** A grant dies with the session; a persistent
   grant requires the user's explicit "remember".

The test suite itself needs only rule-2's narrowest scope — zero prompts, zero
user interaction, by construction.

## The primitives (two, plus one channel)

Additive per the v1.1.0–v1.5.0 rule: a `gateway@1` host without the seam
answers `unavailable` per call, and negotiation keeps every current floor.

### 1. `socketListen` — open a loopback server (grant `socket.listen.loopback`)

```ts
export type SocketListenRequest = {
  scope: "loopback";              // v0: the only scope
  port?: number;                  // omit = host picks a free port
};
export declare function socketListen(request: SocketListenRequest): Promise<
  { serverId: string; port: number } | null>;
```

Binds a loopback TCP listener. Resolves once bound (the resolved `port` is the
source of truth — hosts MUST support port picking). Resolves `null` on user
refusal of the grant. Connections arrive as events on the server channel
(`connection.accepted` carries a `connectionId`); data/close flow per
connection over the same channel (the v1.6.0 seam — no polling, D8).

### 2. `socketConnect` — dial a loopback endpoint (grant `socket.connect.loopback`)

```ts
export type SocketConnectRequest = {
  scope: "loopback";              // v0: the only scope
  host: "127.0.0.1";              // literal loopback only in v0
  port: number;
};
export declare function socketConnect(request: SocketConnectRequest): Promise<
  { connectionId: string } | null>;
```

Dials a loopback TCP endpoint. `connectionId` identifies a duplex stream:
`connection.write(bytes)` (gateway call) + `connection.data` / `connection.close`
events (channel). Half-close is expressed as `connection.end()`; the peer's
close arrives as the `close` event with the trailing bytes already delivered.

### 3. The `socket` channel (v1.6.0 event-channel seam)

One channel per server/connection, carrying `connection.accepted`, `data`,
`close`, `error` — the same shape the render surface uses for frames. No
polling anywhere (D8).

## What v0 deliberately excludes (named non-goals)

- **Remote connect / LAN / any-remote listen**: real product capabilities with
  a real prompt-and-revocation UX — separate grant classes, proposed after v0
  proves the audit model.
- **TLS termination**: v0 sockets are raw byte pipes; TLS-class traffic keeps
  flowing through `httpFetch`, where the full audit already lives.
- **UDP, multicast, Unix domain sockets**: named, not designed.
- **Background listening**: a server lives as long as its opening session.

## Alternatives considered

- **Stay loopback-dispatch only (status quo)**: rejected — the in-process
  dispatch cannot carry traffic between two OS processes, which is exactly the
  shape the subprocess seam created; the excluded spec families are the proof.
- **Ungated raw sockets**: rejected outright — a phone-side plugin that can
  open doors without a grant is the attack surface this proposal exists to
  avoid.
- **Full WASI net (Emscripten-style)**: rejected for v0 — the D16 rationale
  holds (our `wasmRun` seam is deliberately a narrow ABI), and the JS-side
  surface needs a contract primitive anyway; a full WASI host is a larger
  follow-up that would sit ON this primitive, not replace it.
- **ish-guest-only networking**: complementary, not a substitute — the guest
  serves programs that live in the Linux userland; this proposal serves JS
  plugins that speak node's net/http API shape.

## Verification plan

- The seam's first deliverable is the suite itself: the 18 socket-class
  excluded specs (lsp-stdio ×5, ssh loopback-facing ×~8, subprocess-ssh ×5)
  re-enter on a `socket`-granted leg.
- A new e2e leg per host: server + client in one scenario, plus
  child-process × socket (a spawned OS process dials the in-test server) —
  the shape that motivated this proposal.
- Negotiation floors: all three hosts answer `unavailable` until implemented;
  no current behavior changes.

## Version

v1.8.0 (additive: two primitives + one channel; the grant classes reuse the
v1.5.0 family-flag mechanism). Adopted 2026-09-30 — v0 scope: loopback only,
exactly as specified above; hosts without the seam answer `unavailable` per
call and negotiation keeps every current floor.
