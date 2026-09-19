# runtime/spike/

The M1/M2 core spike: quickjs-ng shim running a pinned upstream pure-logic
package, with the E2E verdict emitted as structured logs. M2 replaces the
M1 canned gateway responses with a REAL dispatch bridge to the platform
embedder plus a typed JS shim (`gateway.js`).

- `vendor/ensure.sh` — materializes the engine sources: pinned upstream
  commit + sha256-verified tarball (PROVENANCE.md has the pin). The vendor
  tree is untracked by design; run it before any build.
- `vendor/quickjs-ng/0.17.0/` — verbatim quickjs-ng library sources
  (untracked; materialized by `ensure.sh`). `quickjs-libc` is deliberately
  excluded: the spike host provides its own minimal glue.
- `vendor/dsh/util-crypto@0.1.6-alpha.1/` — verbatim upstream
  `@deepseek-ai/dsh-util-crypto` (zero-dependency, pure logic). The shim
  provides the Web-API seams it needs (`crypto.getRandomValues`, `btoa`)
  instead of editing upstream.
- `logger.js` — plain-ESM port of `runtime/logger/index.ts` (same
  `createLogger` contract; emits one JSON line per entry through the
  host-bound sink).
- `gateway.js` — the typed JS shim over the gateway bridge: every
  contract/primitives.d.ts primitive with its frozen shape, base64 bytes
  both directions, `GatewayError` rejections, `httpFetch` body as an
  AsyncIterable fed by host events, abortable via `__dshGatewayAbort`.
- `registry.js` — the spike service registry: installs plugins as
  `{manifest, module}`, validates the manifest statically, calls the
  declared activate hook; capability negotiation stays the gateway's job.
- `system-plugins` — symlink to the repo-root `system-plugins/` tree, so
  bundle-root-relative imports (`system-plugins/<pkg>/index.js`,
  `logger.js`, `gateway.js`) resolve identically on every host. Note the
  loader contract that falls out: modules with state (the gateway event
  hub) must be imported under ONE canonical specifier, or the two
  specifiers yield two module instances with two listener sets.
- `manifest.json` — the scenario bundle's plugin manifest
  (`dsh.spike.scenario`); the embedder reads it from
  `bundle_root/manifest.json` and enforces the declared capabilities.
- `scenario/m1-spike-boot.js` — the `m1.spike.boot` E2E scenario: ESM
  package load, host Web-API shims, gateway negotiation. (The M1 canned
  gateway-call blocks are GONE — real primitive dispatch lives in the m2
  scenarios below.)
- `scenario/m2-bridge-smoke.js` — the `m2.bridge.smoke` E2E scenario,
  runnable headless on the desktop CLI: deferred settlement (later-tick),
  tmpdir-backed fs over base64 payloads, scope-escape rejection, and the
  declared-unavailable path.
- `scenario/m2-gateway-binding.js` — the `m2.gateway.binding` E2E scenario
  for the full embedder (iOS): all nine primitives, streaming httpFetch
  body + abort, picker → fsScope roundtrip, keychain roundtrip, and the
  notification/app-state lifecycle, driven by host events.
- `scenario/m2-session.js` — the `m2.session` E2E scenario: the first MINI
  agent session over the system implementation plugins. Platform-neutral
  (CLI + carrier hosts alike): registry installs dsh-fs /
  dsh-subprocess-quickjs / dsh-ui, the host readiness signal (`host.info`
  gateway event — port 0 on the CLI backend, the carrier port when the
  presentation surface is attached) starts the session, the mock LLM
  streams token deltas as an event sequence, one tool call runs through
  the subprocess plugin and persists its result via dsh-fs under scope
  "app", and the session completes with the transcript.
- `system-plugins/` — system implementation plugins (JS, shared across
  platforms; see the repo-root tree): `dsh-fs` (the `fs` service over
  fsRead/fsWrite/fsScope, scope-relative POSIX with escape rejection),
  `dsh-subprocess-quickjs` (the `subprocess` service as the in-process
  coroutine executor — event-driven progress/completion, no OS
  processes), `dsh-ui` (approval / picker / notify + notify.response
  round trip). Each ships a manifest.json that validates against
  contract/schemas/manifest.schema.json.
- `scenario/m1-carrier-loopback.js` — the `m1.carrier.loopback` E2E
  scenario: the local-carrier topology (static files + WS pump) asserted
  through the bus seam, for hosts that implement it (see below).
- `web/` — the spike Presentation page (`index.html` + `carrier-page.js`),
  served as static files by a host carrier; it knows only the WS protocol.
- `host/` — the platform-neutral C shim every platform host links
  (`dsh_spike_host.c` + `main_cli.c` desktop driver + `build.sh`).
- `artifacts/` — committed evidence per environment (logs, verdict,
  receipt).

## Embedding contract (platforms)

Run `vendor/ensure.sh` first, then link
`host/dsh_spike_host.c` + `vendor/quickjs-ng/0.17.0/{dtoa,libregexp,
libunicode,quickjs}.c`, then from a SINGLE thread:

1. `dsh_spike_new(bundle_root, &sink)` — sink receives canonical
   `dsh.spike.log: {...}` lines; print them to the native log unmodified.
2. register the gateway bridge BEFORE eval:
   - `dsh_spike_set_gateway_dispatch(s, on_call, ud)` — every
     `__dshGatewayCall(name, argsJson)` gets a monotonic `call_id` (from 1)
     and invokes `on_call(ud, call_id, name, args_json)` synchronously ON
     THE RUNTIME THREAD; hop the work to your transport queue there, never
     block. Multiple calls may be in flight.
   - `dsh_spike_set_descriptor(s, descriptor_json)` — stores the runtime
     descriptor JS reads via `__dshGatewayDescriptor()` (verbatim, or
     `"null"` when never set).
3. read + `dsh_spike_eval(s, "scenario/m2-gateway-binding.js", source)`.
4. settle and stream from the RUNTIME THREAD ONLY (dispatch your platform
   results onto that queue first — ARCHITECTURE.md §6 thread rules):
   - `dsh_spike_gateway_settle(s, call_id, ok, payload_json)` — resolves
     (ok=1) / rejects (ok=0) the promise stored for `call_id` with
     `payload_json` parsed as a JSON value (`"null"` resolves null).
     Unknown or already-settled id → -1 (fail loud). Drains pending jobs
     after settling.
   - `dsh_spike_gateway_event(s, event_json)` — calls the JS global
     `__dshGatewayOnEvent(eventJson)` when the scenario subscribed
     (undefined handler → 0, dropped), then drains pending jobs. This is
     the channel for `http.body` / `http.end` / `http.error` stream
     events, `host.info`, `app.state`, and `notify.response`.
5. `dsh_spike_pump(s)` — drains microtasks until quiescent (settlement now
   happens exclusively through the two calls above).
6. verdict = `dsh_spike_complete(s) && dsh_spike_pass(s)` (plus the
   `tools/e2e/check.mjs` one-to-one match over the captured lines).

JSON conventions on the bridge: byte payloads travel base64 in fields
ending `B64`; errors are objects `{"code","primitive","message"}` with
`code` ∈ denied|unavailable|invalid|io|network|timeout|cancelled; handles
and refs are opaque strings. `__dshGatewayAbort(callId)` dispatches an
`on_call` with name `httpFetch.abort` and args `{"callId":<n>}`.

### Carrier bus seam (m1.carrier.loopback only)

Hosts proving the local-carrier topology additionally register
`dsh_spike_set_bus_sink(s, on_bus, ud)` BEFORE eval, then keep the runtime
alive and shuttle one-JSON-line messages:

- JS → host: the scenario calls `__dshBusPost(line)`; `on_bus` fires on the
  runtime thread (hop to your transport queue there, never block).
- host → JS: from the runtime thread only, `dsh_spike_bus_deliver(s, line)`
  invokes the scenario's `__dshBusOnMessage` handler and drains microtasks;
  check `dsh_spike_complete`/`dsh_spike_pass` after each deliver.

The message vocabulary (`bus.ready`, `host.hello`, `ws.hello`, `ws.send`,
`ws.message`) is spike-local; M2 replaces it with the real session
projection protocol — do not build on it.

## Desktop proof run

```sh
runtime/spike/host/build.sh
cd runtime/spike && ./build/dsh-spike-cli . scenario/m1-spike-boot.js > logs.txt
node tools/e2e/check.mjs --manifest tools/e2e/scenarios/m1-spike-boot.json --log runtime/spike/logs.txt
./build/dsh-spike-cli . scenario/m2-bridge-smoke.js > logs-m2.txt
node tools/e2e/check.mjs --manifest tools/e2e/scenarios/m2-bridge-smoke.json --log runtime/spike/logs-m2.txt
```

The CLI driver doubles as the gateway bridge SMOKE BACKEND: it declares
fsRead/fsWrite/fsScope available (everything else unavailable), answers fs
calls from a fresh temp dir exposed as scope "app" (creating intermediate
directories on write, like the platform fs primitives), delivers the
host-readiness signal (`host.info`, port 0) right after eval, and defers
every settlement to the post-pump drain pass — proving the later-tick
pattern. The `m2.session` scenario runs on the same driver:

```sh
./build/dsh-spike-cli . scenario/m2-session.js > logs-m2-session.txt
node tools/e2e/check.mjs --manifest tools/e2e/scenarios/m2-session.json \
  --log logs-m2-session.txt
```
