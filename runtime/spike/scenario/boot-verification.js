/**
 * M1 spike scenario `boot.verification` — the E2E contract lives here: every
 * expected event emits exactly one structured log entry through the unified
 * logger, in the order declared by tools/e2e/scenarios/boot-verification.json.
 * The verdict is a one-to-one expected<->logged match on these lines only;
 * screenshots are local-debugging extras, never the assertion.
 *
 * Proves, on any platform that embeds runtime/spike/host: the ESM loader
 * resolving a vendored upstream pure-logic package (D6: pinned, unmodified),
 * the host-provided Web-API seams (crypto.getRandomValues, btoa), and
 * gateway negotiation (gateway@1). The M1 canned gateway-call blocks are
 * GONE — real primitive dispatch now lives in the m2 scenarios over the
 * dsh_spike_set_gateway_dispatch bridge (gateway.bridge-smoke on the desktop
 * CLI, gateway.binding on the full embedder).
 */
import { createLogger } from '../logger.js';
import { randomUUID, bytesToBase64 } from 'dsh:util-crypto';
// The shim faces the upstream-suite sweep distilled into regression pins
// (2026-09-25): the same classes the product globals serve, asserted here so
// every CI boot re-proves them on-device — seconds, no scenario runner.
import { DshBuffer } from 'upstream/shims/buffer.js';
import { TextDecoder as DshTextDecoder } from 'upstream/shims/util.js';
import { fileURLToPath } from 'upstream/shims/url.js';
import * as fsPromises from 'node:fs/promises';

const SCENARIO = 'boot.verification';
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

  // The shim self-test: the four faces the first full upstream-suite sweep
  // found broken or missing (see the 2026-09-25 bug-fix note). Each assert
  // is the exact regression its fix closed.
  {
    // TextDecoder's non-fatal branch drove a bare decodeUtf8 that was never
    // imported — any non-fatal decode crashed. Multibyte on purpose.
    const decoded = new DshTextDecoder().decode(
      Uint8Array.from([104, 0xc3, 0xa9, 0xe4, 0xbd, 0xa0])); // "hé你"
    // Buffer.from's single-byte family (ascii/latin1) was unsupported.
    const ascii = DshBuffer.from('héllo', 'latin1').length === 5
      && DshBuffer.from('abc', 'ascii')[0] === 0x61;
    // fileURLToPath resolves scheme-less RELATIVE paths (the loader's
    // import.meta.url spelling for bundle-relative modules).
    const rel = fileURLToPath('upstream-tests/x.spec.mjs') === '/upstream-tests/x.spec.mjs';
    const abs = fileURLToPath('/already/absolute') === '/already/absolute';
    // node:fs/promises carries the rmdir/symlink exports the sandbox faces
    // link against (an ESM named import from a missing export is a link
    // error even when unreached).
    const linked = typeof fsPromises.rmdir === 'function'
      && typeof fsPromises.symlink === 'function';
    emit('shims.selftest', {
      textDecoder: decoded === 'hé你' ? 'utf8+multibyte ok' : `BROKEN: ${JSON.stringify(decoded)}`,
      bufferSingleByte: ascii ? 'ascii/latin1 ok' : 'BROKEN',
      fileURLToPath: rel && abs ? 'relative+absolute ok' : 'BROKEN',
      fsPromises: linked ? 'rmdir+symlink linked' : 'BROKEN',
    });
    if (!decoded.startsWith('hé') || !ascii || !rel || !abs || !linked) {
      fail('shim self-test failed — see the shims.selftest event');
    }
  }

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
}
