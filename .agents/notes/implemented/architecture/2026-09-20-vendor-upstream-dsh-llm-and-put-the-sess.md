# Agent Note: Vendor upstream dsh-llm and put the session turn on the gateway transport seam

Status: implemented
Related: D9

## Problem

The D9 port's upstream session still ran its model turn through
`model.scripted`, an in-house scripted driver standing in for the llm
service, and dsh-llm's pure value helpers shipped as a staged upstream-SHAPE
shim (`shims/dsh-llm*.js`) rather than the real package. The mobile runtime
therefore had: (a) a forked copy of upstream behavior that would drift with
every upstream release — the exact failure D9 exists to prevent; (b) no
llm path at all — QuickJS has no `fetch`/sockets, and the CLI driver's
gateway descriptor declared `httpFetch` unavailable, so nothing could
exercise the one primitive a model transport needs.

## Decision

The W-LLM leg lands the real llm stack, all upstream code verbatim, all
platform difference in the seam layer:

- **Vendor closure grows by two**: `@deepseek-ai/dsh-llm` and
  `@deepseek-ai/dsh-llm-mock-server` at 0.1.6-alpha.2 join
  `vendor/ensure-dsh.sh`'s pin table (tgz sha256; trees untracked,
  byte-diffed against the tarballs). The staged `shims/dsh-llm.js` +
  `shims/dsh-llm-stream.js` value-helper shim and `model-scripted.js` are
  DELETED — retiring them was the designed one-loader-row change: the bare
  specifier now falls through to the vendored package, and dsh-llm's
  runtime subpaths map through its real exports table (anything else fails
  loud). `dsh-llm-replay` stays out: its peer closure (compaction,
  api-extensions) buys nothing for this leg.
- **node:module seam**: dsh-llm reads its own package.json at load for
  attribution headers (`createRequire(import.meta.url)("../package.json")`).
  The host loader now pins `import.meta.url` to the module name (what
  quickjs's own loader does) and serves `__dshBundleRequire(base, request)`:
  the C seam resolves `base` through the SAME bare map the loader owns (one
  specifier→path table), then serves relative `.json` reads under the
  bundle root — nothing else, fail loud. `shims/node-module.js` is the
  thin createRequire over it.
- **Transport seam** (`upstream/llm-transport.js`): an upstream-SHAPE
  OpenAI-compatible chat-completions `LlmAdapter` whose transport is
  gateway `httpFetch` end to end — wire request serialized from the harness
  message vocabulary, attribution headers from the VENDORED package,
  non-2xx bodies diagnosed into `LlmError` provider-neutral codes
  (upstream mapping), SSE parsed incrementally from the http.body
  AsyncIterable (reads may split anywhere incl. mid-UTF-8), `[DONE]`
  sentinel contract (a truncated stream is STREAM_CLOSED, never trusted),
  abort → `cancelled` GatewayError → `ABORTED`, and the upstream translate
  semantics (deferred block-end/usage/finish, EMPTY_RESPONSE degenerate
  check). `boot.js` mounts the vendored `LlmRuntime` under `llm` and
  registers this adapter for the caller's provider route; there is no
  transport-free fallback anymore — a boot without `options.llm` fails
  loud.
- **E2E**: `m2.upstream-session` now streams the VENDORED
  dsh-llm-mock-server (a real node:http SSE server, driven node-side by
  `ci/mock-llm-server.mjs` — start, condition-polled endpoint wait, kill in
  the runner) through the CLI's new `--http` loopback httpFetch backend
  (POSIX sockets, chunked/content-length framing, http.body streaming;
  loopback-only by policy) and `--env` launch snapshot. Explicit llm-path
  evidence: `llm.request.built` (with upstream's own `isAgentLoopRequest`
  WeakSet marker proving the loop built the request), per-payload
  `llm.sse.*` (deltas, usage, [DONE]), and a second leg streaming the
  mock's scripted 401 through `ctx.llm.stream` to prove structured errors
  surface as the upstream error-finish protocol (`llm.transport.error`,
  AUTH/401). One-to-one manifest 31/31, three consecutive runs
  byte-identical (md5 c1d7ac78b472622e90f55920646678df); all five existing
  CLI scenarios re-verified green (default binary behavior unchanged —
  `--http` is opt-in so m2.bridge.smoke/m3-complete descriptor evidence
  stays stable).

## Alternatives considered

- Vendor dsh-llm-deepseek instead of writing the adapter: rejected — it is
  the desktop's direct-fetch transport (fetch + EventSourceParserStream +
  TextDecoderStream, DeepSeek-specific thinking/file APIs); vendoring it
  would need a fetch shim AND upstream-side protocol surface this profile
  does not mount. The gateway adapter mirrors its wire layer (same finish
  mapping, usage disambiguation, SSE contract) with the seam swapped, so
  re-pinning later keeps the same shape.
- Reuse dsh-llm-replay's recorded transport for E2E: rejected — its peer
  closure (compaction, deepseek api-extensions) drags packages this leg
  never mounts, and a recorded transport would not exercise the real
  HTTP/SSE path the gateway bridge exists to prove. The mock server runs
  node-side as a genuine loopback server instead.
- Serve `require('../package.json')` from a shim-side constants table
  (version string duplicated in JS): rejected — drift-prone duplication of
  upstream data; the C bundle-read seam keeps the vendored package.json the
  single source while staying read-only and root-confined.
- Keep `model.scripted` as a fallback when no llm route is configured:
  rejected — a silent scripted turn behind a missing-configuration path is
  the "silently wrong" failure rule 5 exists for; the boot fails loud
  naming the missing option instead.
