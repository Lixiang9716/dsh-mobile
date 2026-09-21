# Agent Note: Real LLM streaming session (m2.llm) over the gateway httpFetch

Status: implemented
Related: D8

## Problem

M2's session milestone shipped with a mock LLM: `m2.session` streams canned
token arrays, so the milestone row still read "still open: real LLM API".
Nothing proved that a real streaming chat completion can cross the frozen
gateway: SSE bytes arriving as host `http.body` events, partial lines and
chunk boundaries, reasoning deltas before content deltas, credentials that
must never touch a log line, and an aggregated transcript assembled from
what actually streamed. Any of these failing would surface only when the
first real agent ran — late, on every host at once. And a mock-free E2E has
a verification problem of its own: real delta counts, delta texts, and the
server-reported model name are nondeterministic, while the checker demands
a one-to-one expected<->logged match.

## Decision

`runtime/spike/llm.js` is an OpenAI-compatible streaming chat client whose
transport is a PARAMETER with the gateway `httpFetch` response shape
(`{status, headers, body: AsyncIterable<Uint8Array>, abort()}`) — the
install-fetch pattern. Scenario `m2.llm` negotiates its leg from the
RuntimeDescriptor (httpFetch offered → real backend; declared unavailable
on the CLI smoke backend → a scripted SSE feed through the same client
code), never via a hostType branch. Credentials ride fs scope "app"
(`m2-llm/config.json`, staged by the runners), and the scenario wraps the
log sink from its first line, auditing every line for the active key and
failing loud on a leak (the CLI leg audits a non-secret fixture key, so the
audit mechanism itself is under test in CI). The checker gained one
extension: a `"repeat": true` expectation greedily consumes one-or-more
consecutive matching records (proven by selftest fixtures), which lets the
device manifests assert "≥1 delta, in this position, matching these
fields" while staying one-to-one everywhere else. Evidence: scripted leg
19/19 (`runtime/spike/artifacts/macos-cli-m2-llm/`), real z.ai streaming on
the iOS simulator (88 reasoning + 15 content deltas, served model
`glm-5.3-flash` logged for the requested `glm-4.6` —
`hosts/ios/artifacts/m2-llm/`) and on the Android emulator
(`hosts/android/artifacts/m2-llm/`). The first iOS run failed 401 because
`HTTPPrimitive` read a nested `init` object the typed shim never sends —
it silently dropped every request header; it now reads the shim's
flattened `{method, headers, bodyB64}` encoding (surprise ledger).

## Alternatives considered

- Whole-result chat API (non-streaming `stream: false`) — far simpler, no
  SSE parser needed; rejected: it violates D8 (a blocking whole-result API
  is exactly what the architecture rejects in review) and would hide the
  `http.body` streaming path the session experience depends on.
- Leg selection by launch argument or per-host scenario files — tempting
  because the descriptor read is one line either way; rejected: it is the
  RFC 0002 anti-pattern (hostType branching) in miniature; the descriptor
  already IS the negotiation surface.
- Config via launch args / env vars read host-side — would need new seams
  in two hosts (Swift + Kotlin) to pass credentials into JS; rejected:
  scope "app" fs is the existing, frozen data path, and the same
  `m2-llm/config.json` works unchanged on every host.
- Two manifests with fixed delta counts (assert the first N deltas) or
  logging only a delta summary on device — either weakens the contract
  (silent truncation) or logs different event shapes per leg; the repeat
  expectation keeps one scenario code path and one event vocabulary
  (`llm.delta` {index, text}, byte-identical to `m2.session`) with the
  nondeterminism stated where it is real.
- A separate LLM primitive on the gateway (contract change) — the
  contract-first path if the JS-side parser proves too heavy; not needed:
  the whole client is ~250 lines over the existing `httpFetch` shape, and
  keeping it JS keeps it host-isomorphic and testable in CI without a
  device.
