/**
 * M1 spike scenario `m1.spike.boot` — the E2E contract lives here: every
 * expected event emits exactly one structured log entry through the unified
 * logger, in the order declared by tools/e2e/scenarios/m1-spike-boot.json.
 * The verdict is a one-to-one expected<->logged match on these lines only;
 * screenshots are local-debugging extras, never the assertion.
 *
 * Proves, on any platform that embeds runtime/spike/host: the ESM loader
 * resolving a vendored upstream pure-logic package (D6: pinned, unmodified),
 * the host-provided Web-API seams (crypto.getRandomValues, btoa), async
 * gateway calls resolved from the host side on a later pump tick (D2: no
 * threads, no subprocesses — the host drives the runtime queue), and the
 * frozen gateway v1.0.0 conformance path for an unavailable primitive (D5).
 */
import { createLogger } from '../logger.js';
import { randomUUID, bytesToBase64 } from 'dsh:util-crypto';

const SCENARIO = 'm1.spike.boot';
const log = createLogger('m1.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
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
  emit('package.loaded', { name: '@deepseek-ai/dsh-util-crypto', version: '0.1.6-alpha.1' });

  const uuid = randomUUID();
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);
  emit('crypto.shim.ok', { uuid, v4 });

  const bytes = Uint8Array.from([104, 101, 108, 108, 111]); // "hello"
  emit('base64.shim.ok', { input: 'hello', b64: bytesToBase64(bytes) });

  const read = await globalThis.__dshGatewayCall('fsRead', JSON.stringify({ path: 'bundle://probe.txt' }));
  emit('gateway.call.ok', { name: 'fsRead', bytes: read.bytes });

  try {
    await globalThis.__dshGatewayCall('keychainGet', JSON.stringify({ key: 'spike' }));
    fail('keychainGet should be declared unavailable by the host');
  } catch (err) {
    emit('gateway.call.unavailable', { name: 'keychainGet', code: err.code });
  }

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
}
