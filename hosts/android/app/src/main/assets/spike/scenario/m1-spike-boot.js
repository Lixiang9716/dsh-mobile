/**
 * M1 spike scenario `m1.spike.boot` — the E2E contract lives here: every
 * expected event emits exactly one structured log entry through the unified
 * logger, in the order declared by tools/e2e/scenarios/m1-spike-boot.json.
 * The verdict is a one-to-one expected<->logged match on these lines only;
 * screenshots are local-debugging extras, never the assertion.
 *
 * Proves, on any platform that embeds runtime/spike/host: the ESM loader
 * resolving a vendored upstream pure-logic package (D6: pinned, unmodified),
 * the host-provided Web-API seams (crypto.getRandomValues, btoa), and
 * gateway negotiation (gateway@1). The M1 canned gateway-call blocks are
 * GONE — real primitive dispatch now lives in the m2 scenarios over the
 * dsh_spike_set_gateway_dispatch bridge (m2.bridge.smoke on the desktop
 * CLI, m2.gateway.binding on the full embedder).
 */
import { createLogger } from '../logger.js';
import { randomUUID, bytesToBase64 } from 'dsh:util-crypto';

const SCENARIO = 'm1.spike.boot';
const log = createLogger('m1.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  log.debug('scenario failed', { reason });
  emit('scenario.failed', { reason });
  globalThis.__dshComplete(false, reason);
};

const engine = globalThis.__dshEngineInfo();
emit('runtime.created', { engine: engine.name, engineVersion: engine.version });
emit('sink.bound', {});

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('gateway.negotiated', { version: 'gateway@1' });
  emit('package.loaded', { name: '@deepseek-ai/dsh-util-crypto', version: '0.1.6-alpha.2' });

  const uuid = randomUUID();
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);
  emit('crypto.shim.ok', { uuid, v4 });

  const bytes = Uint8Array.from([104, 101, 108, 108, 111]); // "hello"
  emit('base64.shim.ok', { input: 'hello', b64: bytesToBase64(bytes) });

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
}
