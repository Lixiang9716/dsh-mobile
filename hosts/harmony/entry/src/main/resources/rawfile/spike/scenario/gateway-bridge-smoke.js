/**
 * M2 bridge smoke scenario `gateway.bridge-smoke` — runs headless on the desktop
 * CLI (main_cli.c's smoke backend answers the real dispatch bridge). Every
 * expected event emits exactly one structured log entry through the unified
 * logger, in the order declared by test/e2e/scenarios/gateway-bridge-smoke.json.
 *
 * Proves the bridge end to end without a platform embedder: deferred
 * settlement (calls queue in on_call and settle on a later tick after the
 * pump pass), tmpdir-backed fs primitives carrying base64 byte payloads,
 * the scope-escape "invalid" path, and the keychain roundtrip (set → get
 * bytes-equal → delete → get null) over the same frozen contract shapes the
 * device hosts back with SecItem/Keystore — the dev host stores one 0600
 * file per ref under the smoke tmpdir, the same trust domain as its fs
 * scopes. The declared-unavailable conformance path stays covered by every
 * primitive the descriptor still names unavailable (notify, presentApproval,
 * the device plane).
 */
import { createLogger } from '../logger.js';
import { fsRead, fsWrite, keychainGet, keychainSet } from '../gateway.js';

const SCENARIO = 'gateway.bridge-smoke';
const log = createLogger('m2.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  log.debug('scenario failed', { reason });
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

  const secret = Uint8Array.from([1, 2, 3, 0xfe, 0xff]); // non-UTF-8 on purpose
  await keychainSet('dsh.spike/cred', secret);
  const stored = await keychainGet('dsh.spike/cred');
  emit('keychain.roundtrip', { set: true, match: !!stored && bytesEqual(stored.secret, secret) });

  await keychainSet('dsh.spike/cred', null);
  const gone = await keychainGet('dsh.spike/cred');
  emit('keychain.deleted', { gone: gone === null });

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
}
