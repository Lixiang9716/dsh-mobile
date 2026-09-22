# Agent Note: the launch-env note rides the canonical envelope, not free text

Status: implemented

## Problem

Ever since #138 landed the guest-userland declaration, both m1 scenarios on
dev/ios failed with `expected: 7, logged: 7, failures: []` — and exactly one
parseError: `dsh.spike.log: launch env declares the guest userland: <path>`.
The checker parses EVERY line carrying the `dsh.spike.log:` prefix as the
unified-logger envelope; free text after the prefix is a parse error against
every scenario riding the capture, and `pass` requires zero parseErrors. The
verdicts were "7/7 match but one unparsable line" — CI red on two scenarios
whose expectations had all actually been met (runs 35726968953, 35755621852,
35756986102).

## Decision

`SpikeHostFactory.dsh_spike_new_declaring` emits the declaration as ONE
canonical record on the same stream — the unified-logger envelope built with
`GatewayCore.jsonLine`, prefixed by `SpikeLogSink.prefix` — under the reserved
`host.launch` scenario id (`data[0].scenario = "host.launch"`, event
`ish.rootfs.declared`). Manifests filter on their own scenario id, so the
record is invisible to every scenario's one-to-one walk while the capture
keeps the evidence; level `info`, so the release build's warn/error strip
drops it like every other debug-fact line.
`tools/e2e/selftest.sh` gains the rejection pair (rule 6):
`host-note.positive.txt` (envelope record → PASS, proves the filter) and
`host-note.negative-free-text.txt` (free text → FAIL with a parseError,
via the new `expect_parse_error` helper) — the exact shape that reddened CI.

## Alternatives considered

- Delete the note outright — loses the only in-capture evidence that the
  launch env (the `ishRun` declaration) reached the host; the note channel
  exists precisely for pre-entry-module host facts.
- Expect the event in the m1 manifests — wrong direction: a host with no
  userland must stay silent (the factory's own contract), so m1 cannot
  assert a fact that is conditional; it would also couple the minimal boot
  scenario to ish provisioning.
- Emit bare JSON without the `data` array (the checker skips such lines
  silently) — parses, but a shape no other line on the stream uses; the
  envelope + reserved scenario id is self-describing and greppable, and a
  future manifest CAN adopt `host.launch` records by naming that scenario.
