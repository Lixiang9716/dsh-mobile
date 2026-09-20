# Agent Note: M3 UI pluggability: config-selected Web Client swap + plugin toolbar slot acked by the page

Status: implemented
Related: D8

## Problem

M2 mounted exactly one Web Client (`dsh-web-client`) with the choice baked
into the host, and plugins had no way to contribute UI surface: "the UI is a
pluggable Web Client" and "plugins extend the UI" were architecture prose
with no proof. The session scenario also had a determinism hazard to keep:
any new page-rendered evidence must land at a FIXED position in the
one-to-one E2E log stream, or the log checker (order-sensitive, nothing
extra) goes red.

## Decision

- Web Client swap: a second, visually distinct variant ships at
  `presentation/web-client-mini/` (own manifest, `dsh-web-client-mini`,
  amber monospace transcript). The staged bundle carries both; the ACTIVE
  client id comes from the launch configuration (`-dsh-web-client`, default
  unchanged), `SessionRuntime` maps the id to its staged directory (fail
  loud on unknown ids) and serves THAT directory. Selecting the mini client
  also flips the carrier-side evidence to scenario `m3.ui-swap`
  (`tools/e2e/run-ios-session.sh --client mini`); the default client keeps
  asserting `m2.webclient.mount`. `client.selected` is logged at session
  start, so the checker pins the configuration decision itself.
- Toolbar slot: both clients support one typed slot — the plugin projects
  `{"kind":"slot.register","id","label","by"}` over the existing
  session-projection bus; the page renders a toolbar button and ACKS with
  `{"type":"slot.ack"}`; the carrier logs `slot.registered` — evidence of
  the RENDERED state, not of the intent. `dsh-notes` arrives through the
  M3 install pipeline inside `m2.session` (receipt committed on device) and
  registers the slot before the session starts.
- Determinism: carrier hosts now gate the `host.info` readiness signal on
  hello AND the slot ack. The slot projection is pushed pre-connect, so the
  replay renders it for late-connecting pages; the ack therefore always
  precedes the first token delta, keeping the carrier event order fixed:
  client.selected → mounted → connected → slot.registered → deltas →
  complete. The CLI host delivers host.info directly and is unaffected.

On-device evidence: `m3.ui-swap` 7/7 + `m2.session` 23/23 under
`hosts/ios/artifacts/m3-pluginization/` (screenshots include the rendered
"notes" toolbar button in the mini client); regression `m2.webclient.mount`
7/7 + `run-ios.sh` 4/4 on the unchanged default client.

## Alternatives considered

- A second app target/binary for the mini client — beat by the launch-
  argument selection in the same binary: the milestone's claim is that the
  HOST selects the client from configuration; forking the app would prove
  nothing about pluggability.
- Plugin JS injecting arbitrary DOM over the bus — beat by the typed slot:
  the page owns rendering and only binds id+label; a raw DOM channel would
  make the client an XSS surface and the bus a rendering protocol.
- Logging `slot.registered` from the JS scenario after projecting — beat by
  the page ack routed through the carrier: the scenario-side log proves only
  that the message was SENT; the ack after DOM insertion is rendered-state
  evidence and matches the log-based-E2E rule (verify the world, not the
  self-report).
- Polling for the ack with a timeout before starting the session — beat by
  gating host.info on the ack (rule 8: wait on conditions, not clocks; the
  readiness signal IS the condition).
- A new gateway primitive for slot registration — beat by reusing the
  session-projection bus vocabulary: the contract is frozen (D5) and the
  slot is presentation-layer data, not a platform capability.
