# Agent Note: The m2.llm real-LLM leg on the HarmonyOS host

Status: implemented
Related: D8, D9

## Problem

M5's status row carried one honest gap after the nine primitives landed:
"still open: the `m2.llm` real-LLM leg on this host (rides the same httpFetch
binding)". Every other host had it — the CLI runs the scripted-SSE leg, iOS
and Android stream real z.ai turns — and the harmony host had no way to
select it: its page runs a fixed chain (regression trio → m5 binding → D9
official-web legs) with no launch-argument equivalent of Android's
`--ez dsh.llm true`, and the default chain must never spend serve quota. Two
platform facts made the obvious port impossible as well: the app sandbox is
not shell-writable (so the credentials cannot be staged the way
`hosts/android` does with `run-as` or `hosts/ios` does by writing into the
simulator container), and this SDK's only permission API, the deprecated
`@ohos.fileio.chmodSync`, is a silent no-op on these files. Without a leg
that runs the SAME `runtime/spike/scenario/m2-llm.js` over the SAME host
`httpFetch` binding, "capability negotiation, not hostType branching" would
rest on two hosts instead of three.

## Decision

The harmony host runs the m2.llm leg as a launch-selected phase of the SAME
controller that hosts the binding phase (`HostPhase.beginLlm`), exactly as
Android's `SpikeHostM4` swaps its entry for `--ez dsh.llm true`. Four pieces:

- **Selection is a want parameter.** `EntryAbility.onCreate` parks
  `--ps dsh.e2e.leg m2.llm` in `E2eLeg` before the window stage loads the
  page; `Index.aboutToAppear` runs the leg alone, and an unknown value fails
  loud instead of silently running the default chain. The leg's scenario id
  and JS entry are the only things the controller swaps; its carrier-side
  evidence rides `m2.llm.carrier` (the sibling manifest the iOS/Android legs
  already ship) while the m5-only records (`carrier.listening`) are gated, so
  each leg's capture holds exactly its own manifest's records.
- **The credential handoff is inverted, and it is a polled handshake**
  (rules.md rule 8). Measured on the dsh_phone emulator: `hdc shell` cannot
  create a file in the app sandbox (refused even in a 0777 app directory) but
  can open an existing others-writable file; an ArkTS-side create lands 0660,
  which the shell user (neither owner nor in the app's group) cannot open;
  an ArkTS-side `chmodSync` silently leaves the file at 0666. Only the C-side
  app-scope `fsWrite` (fopen) lands 0666, so `e2e-stage.js` — a harmony-only
  bundle file, deliberately outside the portable scenario set — asks the
  runtime's own gateway for the placeholder and posts `stage.ready`, which
  `HostPhase` turns into the `stage-ready` drive marker. The runner then
  overwrites the placeholder with `hdc file send` (its own copy is a 0600
  temp file deleted at the handoff), the app validates the config, logs the
  mode it actually got, and REMOVES the file when the leg ends — removal, not
  permission bits, bounds the key's on-disk life, and both the runner and the
  driver assert it.
- **The leg is one launch, one bounded capture**, like every other harmony
  drive: `hilog` streamed to a file, bounded at the `dsh.spike.verdict:
  m2.llm` tag the C host emits, plus the app's own sink capture pulled with
  `hdc file recv` as the truncation-proof second record. The checkers read
  the pulled capture; a retried attempt is written to a separate file so the
  one-to-one match never sees two attempts' records.
- **Retry is conditional on proof of no spend.** The ArkWeb mount is flaky on
  the emulator (one launch in four never mounted the page and the scenario
  parked on `host.info`); the runner re-wakes the sleeping screen while
  waiting and relaunches only when the pulled capture carries no
  `llm.stream.started` — a retry after a real request would spend quota
  twice, so it never happens.

Evidence: `hosts/harmony/artifacts/m5-m2-llm/` — the launch, the handshake,
the mount chain (`client.selected` → `webclient.mounted` → `ws.connected` →
`slot.registered`), the leg negotiation (`llm.leg {leg: real, transport:
gateway.httpFetch}`, `source: app-scope`) and the REAL transport round trip
(the request leaves the device through this host's httpFetch and the backend
answers). The account's coding-plan quota was exhausted mid-session (HTTP 429
code 1310, reset 2026-09-22 14:43:53), so the served-turn records are NOT in
that capture and the checkers FAIL there by design; the status surfaces say
exactly that, and the served-turn line lands with one re-run of
`hosts/harmony/ci/run-m2-llm.sh`.

## Alternatives considered

- **Reuse the D9 official-web phase for the leg** (the way the session-live
  and write-live legs chain) — rejected: that phase composes the official
  boot wire and its own mock-LLM route before a leg can run, and the m2.llm
  leg needs the carrier's Web Client mount and nothing else. Chaining it also
  means the default `run-host-e2e.sh` run would spend serve quota on every
  invocation.
- **Stage the credentials over an hdc port forward** (`hdc rport`, the app
  fetching its config from a driver-side HTTP server) — rejected for now: it
  is a second unproven transport primitive in the critical path, where the
  handshake above uses only mechanisms already exercised on this device
  (hdc file send, the gateway fsWrite). It stays the cleaner option if the
  platform ever forces the key off the device's disk.
- **Declare the leg's descriptor so the scenario takes its SCRIPTED branch on
  this host** — rejected: it would prove the client code, not the host's
  httpFetch, and the descriptor is a statement of what the host really offers.
- **Wait for the quota and land only with a served turn** — rejected by the
  integrator: the transport proof, the handshake and the mount chain are
  real, committed evidence, and the remaining step needs no code change.

## Consequences

The shipped-turn evidence for this host is a one-command follow-up whose
absence is visible in three places (the README M5 row, the ARCHITECTURE
milestone bullet, and the artifacts' `receipt.json` status field) rather than
implied away. The credential handshake is documented as a platform-forced
inversion, so a future reader does not "simplify" it back into a `run-as`
shape that cannot work here. And the surprise ledger now carries the three
platform facts that shaped it (sandbox write refusal, the chmod no-op, the
`hdc shell` exit-status non-propagation) so the next host-porting task starts
from them instead of rediscovering them.
