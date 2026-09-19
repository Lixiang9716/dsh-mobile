/**
 * M2 bridge smoke scenario `m2.bridge.smoke` — runs headless on the desktop
 * CLI (main_cli.c's smoke backend answers the real dispatch bridge). Every
 * expected event emits exactly one structured log entry through the unified
 * logger, in the order declared by tools/e2e/scenarios/m2-bridge-smoke.json.
 *
 * Proves the bridge end to end without a platform embedder: deferred
 * settlement (calls queue in on_call and settle on a later tick after the
 * pump pass), tmpdir-backed fs primitives carrying base64 byte payloads,
 * the scope-escape "invalid" path, and the declared-unavailable conformance
 * path (keychainGet) per the backend's RuntimeDescriptor.
 */
import { createLogger } from '../logger.js';
import { fsRead, fsWrite, keychainGet } from '../gateway.js';

const SCENARIO = 'm2.bridge.smoke';
const log = createLogger('m2.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  emit('scenario.failed', { reason });
  globalThis.__dshComplete(false, reason);
};

const PROBE = 'dsh-gateway-probe'; // exactly 17 ASCII bytes
const probeBytes = () => Uint8Array.from([...PROBE].map((c) => c.charCodeAt(0)));
const bytesEqual = (a, b) => a.length === b.length && [...a].every((v, i) => v === b[i]);

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('gateway.negotiated', { version: 'gateway@1' });

  const written = await fsWrite('app', 'probe.txt', probeBytes());
  emit('fs.write.ok', { written: written.written });

  const expected = probeBytes();
  const read = await fsRead('app', 'probe.txt');
  emit('fs.read.ok', { bytes: read.bytes.length, matches: bytesEqual(read.bytes, expected) });

  try {
    await fsRead('app', '../escape');
    fail('scope-escaping path should reject invalid');
  } catch (err) {
    emit('fs.read.invalid', { code: err.code });
  }

  try {
    await keychainGet('dsh.spike/cred');
    fail('keychainGet should be declared unavailable by the smoke backend');
  } catch (err) {
    emit('keychain.unavailable', { name: err.primitive, code: err.code });
  }

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
}
