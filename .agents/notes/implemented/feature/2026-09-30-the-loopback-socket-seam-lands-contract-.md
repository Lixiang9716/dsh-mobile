# Agent Note: the loopback socket seam lands (contract v1.8.0, decision matrix D-d) — audited loopback-only TCP

Status: implemented
Related: D5

## Problem

The upstream-suite program excluded 18 socket-class specs for exactly one
contract-level reason: no socket primitive existed (`ssh/ssh` 8,
`lsp/lsp-stdio` 5, `ssh/subprocess-ssh` 5 on the 2026-09-28 ledger). The
v1.5.0 subprocess seam gave the host real OS children, and those children
cannot talk to an in-test server through the in-process loopback dispatch —
two OS processes need a kernel socket between them. The same shape is the
product pull: an LSP integration, an MCP-over-TCP transport, a webhook
receiver — "open a door, talk, close the door." Ungated sockets were the
rejected-from-the-start alternative: a phone-side plugin that opens doors
without a grant is the attack surface the adopted proposal
(`contract/proposals/2026-09-28-socket-seam.md`, decision matrix D-d,
2026-09-30) exists to prevent.

## Decision

The proposal is ADOPTED as contract **v1.8.0** (additive: two primitives +
one channel; proposal files flipped DRAFT→adopted, primitives.md(+zh) gained
the header note, §4 "the socket seam (v1.8.0)", the §5 channel row, and the
d.ts declarations). v0 ships LOOPBACK ONLY under the five-rule model:
direction grading, the narrowest-scope default, family-flag grants, a
gateway audit record on every listen/connect/accept (denied attempts audit
too), session-scoped grants.

The desktop CLI is the v0 host:

- `host/dsh_socket.c/.h` — the loopback-only pump table: bind forces
  INADDR_LOOPBACK, `socketConnect` refuses any host spelling but the literal
  `127.0.0.1` at the C layer too (defense in depth), port 0 makes the host
  pick (the resolved port is the source of truth), non-blocking fds, and the
  per-slot write-backpressure park the pty seam established. Exactly ONE
  intrinsic crosses into JS — `__dshSocketPoll` (one accept/read pass per
  id); everything else (`socketListen`/`socketConnect` and the connection
  face `socketWrite`/`socketEnd`/`socketClose`) travels the gateway-call
  bridge, so grants, audit and `unavailable` negotiation stay where the
  contract puts them. The run loop counts live sockets toward quiescence
  (a run must not exit with doors open), and teardown closes every fd.
- The serve layer owns the grants: the descriptor declares the two loopback
  grants (this CLI is the dev/test profile — the manifest grant source),
  out-of-scope requests reject `denied` with a fixed reason code, and every
  attempt emits one structured audit line on stderr (payload bytes never).
- The JS face: `gateway.js` exposes the five primitives with the frozen
  shapes; `upstream/shims/node-socket-tcp.js` drives the pump (the 4ms
  re-arming tick, the child-process/pty contract) and turns it into the
  node `data`/`close` event sequence; `net.connect`'s registry-MISS branch
  dials real loopback TCP when the seam is negotiated (a registry HIT keeps
  the in-process paired-pipe dispatch byte-for-byte — every existing spec
  keeps its behavior), and `net.Socket`/`net.createServer` serve the real
  faces. A host without the seam answers the honest `ECONNREFUSED`/refusal
  it always did — the negotiation floor, zero behavior change.
- Evidence: `test/e2e/run-socket-seam.sh` (scenario `socket.seam`, checker
  `test/e2e/scenarios/socket-seam-local.json` 17/17, audit gate
  listen=3 connect=2 accept=2 denied=2) — including the leg that motivated
  the seam, a spawned `/bin/bash` child dialing the in-test server over
  `/dev/tcp`, bytes crossing between two OS processes.

## Alternatives considered

- **Everything through gateway calls, poll included**: rejected — the 4ms
  accept/read pump is the established host data face (child-process, pty);
  routing each poll through the gateway bridge would pay the JSON+Promise
  round trip per tick for zero governance gain, since the grant and audit
  live on the primitives that OPEN the door, not on each read.
- **socketWrite/socketEnd/socketClose as intrinsics** (the proc-stdin
  spelling): rejected — the connection face's semantics (backpressure
  counts, half-close ordering, byte-count audit) belong to the contract
  surface; keeping them on the gateway bridge keeps one negotiation and one
  audit story, and the CLI scenario traffic is message-scale.
- **Switching the net face to real TCP wholesale**: rejected — the
  in-process registry dispatch is the behavior baseline the webserver/ws
  suite proves; only the registry MISS (an OS-process peer) falls through
  to the seam, so zero existing behavior moves.
- **Serving the primitives on iOS/Android/HarmonyOS in the same round**:
  rejected for v0 (the scale call in the task brief: land the contract
  flip, the CLI host and the core leg first). Their builds compile
  `dsh_socket.c` (portable POSIX, the dsh_wasm.c spine rule) but their
  gateway layers do not serve it — descriptors stay without the socket
  primitives, which is exactly the `unavailable` negotiation the contract
  prescribes; per-host serving is the named follow-up.
- **node:tls over the seam** (what the ssh/subprocess-ssh families really
  dial — PSK TLS streams): stays a NAMED NON-GOAL, unchanged from the
  proposal. The regression run proved it is the wall: those specs now enter
  and fail loud at `node:tls: createServer is not served` instead of
  timing out, and TLS termination needs its own design round.
