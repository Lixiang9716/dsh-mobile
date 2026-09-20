// dsh:logging-exempt (node-side driver: its stdout IS the product — the
// runner reads the endpoint announce + mock telemetry from it)
/**
 * mock-llm-server.mjs — node-side lifecycle for the VENDORED upstream
 * dsh-llm-mock-server (the E2E test vehicle for the gateway LLM transport).
 *
 * The upstream mock is a real NODE package (node:http) — it runs node-side,
 * outside quickjs, exactly like a desktop dev-loop mock. The runner script
 * (run-upstream-e2e.sh) starts this driver, waits (condition-polled, with a
 * deadline) for the MOCK_BASE_URL line on stdout, points the CLI scenario at
 * it through --env, and kills it at exit. Stdout carries exactly two kinds of
 * lines: the MOCK_BASE_URL=... announce and one JSON line per accepted
 * request (the mock's onEvent telemetry) — diagnostics, not the E2E stream
 * (the checker only reads the CLI's stdout).
 *
 * Script: two behaviors, consumed in order — 'success' for the agent-loop
 * turn (SSE stream of successText 'Hello from upstream', chunked at 5 chars,
 * terminal chunk with finish_reason + usage, then [DONE]) and 'auth_error'
 * for the transport-error leg (401 JSON error body → the adapter's structured
 * AUTH diagnosis). The bearer key must match the adapter's authorization
 * header (wire evidence that the credential path is exercised).
 *
 * usage: node mock-llm-server.mjs
 */
import { startMockLlmServer } from '../vendor/dsh/llm-mock-server@0.1.6-alpha.2/lib/index.js';

const handle = await startMockLlmServer({
  host: '127.0.0.1',
  port: 0, // OS-assigned; announced below (no fixed port races)
  sequence: ['success', 'auth_error'],
  repeatLast: false,
  successText: 'Hello from upstream',
  chunkSize: 5,
  chunkDelayMs: 0,
  apiKey: 'mock-key-0001',
  requestId: 'mock-req-1',
  onEvent: (event) => console.log(JSON.stringify(event)),
});
console.log(`MOCK_BASE_URL=${handle.baseURL}`);

const close = () => {
  handle.close().then(() => process.exit(0));
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
// keep the event loop alive waiting for the CLI's request
setInterval(() => {}, 3600000).unref?.();
