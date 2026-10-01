// dsh:logging-exempt (dev script: the log stream is the product)
/**
 * Scenario `security.gateway-fuzz` — the malformed-primitive battery against
 * the gateway's VALIDATION face (threat model: docs/security-threat-model.md,
 * surface "gateway validation"). The typed shim (gateway.js) is bypassed on
 * purpose: the attacks go through the RAW `__dshGatewayCall` seam exactly the
 * way a hostile or compromised module would — wrong types, missing fields,
 * scope escapes, overlong values, unknown primitive names, malformed args
 * JSON, and out-of-scope socket targets — and every one of them must come
 * back as a STRUCTURED rejection (the contract §3 error codes: invalid /
 * denied / unavailable), never a crash.
 *
 * Two faces get explicit probes beyond the parameter battery:
 *   - the AUDIT face: the socket attacks must leave denied-attempt audit
 *     records on the host's stderr with FIXED reason codes (attacker-
 *     controlled text never enters the audit JSON) — the runner greps them;
 *   - the SURVIVAL face: after the whole battery a benign fsWrite + fsRead
 *     roundtrip still succeeds — the process is alive and the gateway still
 *     serves honest callers (events: fuzz.survived, scenario.complete).
 *
 * The expected codes are pinned per case in
 * test/e2e/scenarios/security-gateway-fuzz.json; a code that drifts (a
 * stricter or looser host) is a visible verdict change, not a silent one.
 */
import { createLogger } from '../logger.js';
import { fsRead, fsWrite } from '../gateway.js';

const SCENARIO = 'security.gateway-fuzz';
const log = createLogger('security.fuzz');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  log.debug('scenario failed', { reason: String(reason).slice(0, 200) });
  emit('scenario.failed', { reason: String(reason).slice(0, 300) });
  globalThis.__dshComplete(false, String(reason).slice(0, 300));
};

/** One RAW gateway call, the way hostile code makes it: no typed shim, no
 * validation on this side. Resolves {ok:true, res} or {ok:false, code}. */
const raw = async (name, args) => {
  const argsJson = typeof args === 'string' ? args : JSON.stringify(args);
  try {
    const res = await globalThis.__dshGatewayCall(name, argsJson);
    return { ok: true, res };
  } catch (err) {
    return { ok: false, code: err?.code ?? null };
  }
};

/** One battery case: fire it, demand the expected rejection code, record it.
 * A case that RESOLVES (the attack landed) is the scenario's failure — that
 * is the high-severity finding this leg exists to catch. */
const battery = [];

const attack = (name, primitive, expect, fn) => {
  battery.push({ name, primitive, expect, fn });
};

// ---- wrong types -----------------------------------------------------------
attack('type.scope-number', 'fsRead', 'invalid',
  () => raw('fsRead', { scope: 7, path: 'probe-fuzz.txt' }));
attack('type.path-object', 'fsRead', 'invalid',
  () => raw('fsRead', { scope: 'app', path: { a: 1 } }));
attack('type.bytes-number', 'fsWrite', 'invalid',
  () => raw('fsWrite', { scope: 'app', path: 'probe-fuzz.txt', bytesB64: 7 }));
attack('type.ref-number', 'keychainGet', 'invalid',
  () => raw('keychainGet', { ref: 9 }));

// ---- missing fields --------------------------------------------------------
attack('missing.fsread', 'fsRead', 'invalid', () => raw('fsRead', {}));
attack('missing.httpfetch.url', 'httpFetch', 'invalid',
  () => raw('httpFetch', { method: 'GET' }));

// ---- scope escapes ---------------------------------------------------------
attack('escape.dotdot', 'fsRead', 'invalid',
  () => raw('fsRead', { scope: 'app', path: '../outside.txt' }));
attack('escape.absolute', 'fsRead', 'invalid',
  () => raw('fsRead', { scope: 'app', path: '/etc/passwd' }));

// ---- authorization (a well-formed call for a scope the host never granted) --
attack('auth.scope-unknown', 'fsRead', 'denied',
  () => raw('fsRead', { scope: 'session', path: 'probe-fuzz.txt' }));
attack('auth.scope-case', 'fsRead', 'denied',
  () => raw('fsRead', { scope: 'APP', path: 'probe-fuzz.txt' }));

// ---- overlong values -------------------------------------------------------
attack('overlong.path-1m', 'fsRead', 'io',
  () => raw('fsRead', { scope: 'app', path: 'a'.repeat(1000000) }));
attack('overlong.keychain-ref', 'keychainGet', 'invalid',
  () => raw('keychainGet', { ref: 'k'.repeat(4096) }));

// ---- bounds ----------------------------------------------------------------
attack('timer.negative', 'timerSchedule', 'invalid',
  () => raw('timerSchedule', { delayMs: -5 }));
attack('timer.missing', 'timerSchedule', 'invalid',
  () => raw('timerSchedule', {}));

// ---- unknown primitives (names that must not exist) ------------------------
attack('unknown.fschmod', 'fsChmod', 'unavailable', () => raw('fsChmod', {}));
attack('unknown.spawn', 'processSpawn', 'unavailable', () => raw('processSpawn', {}));
attack('unknown.empty-name', '', 'unavailable', () => raw('', {}));

// ---- malformed args JSON (the host parses attacker-controlled bytes) -------
attack('malformed.not-json', 'fsRead', 'invalid',
  () => raw('fsRead', '{not json'));
attack('malformed.truncated', 'fsRead', 'invalid',
  () => raw('fsRead', '{"scope":"app","path":'));

// ---- the socket boundary (jail face, audited denials) ----------------------
attack('socket.scope-lan', 'socketListen', 'denied',
  () => raw('socketListen', { scope: 'lan', port: 0 }));
attack('socket.host-metadata', 'socketConnect', 'denied',
  () => raw('socketConnect', { scope: 'loopback', host: '169.254.169.254', port: 80 }));

const main = async () => {
  if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
    fail('gateway negotiation failed');
    return;
  }
  emit('fuzz.started', { cases: battery.length });

  for (const { name, primitive, expect, fn } of battery) {
    const outcome = await fn();
    if (outcome.ok) {
      // THE finding: an attack landed where the contract demands a rejection.
      fail(`attack landed: ${name} (${primitive}) resolved instead of ${expect}`);
      return;
    }
    if (outcome.code !== expect) {
      fail(`${name}: expected ${expect}, got ${outcome.code}`);
      return;
    }
    emit('fuzz.case', { attack: name, primitive, expect, code: outcome.code });
  }
  emit('fuzz.battery.rejected', { cases: battery.length });

  // The survival face: the process is alive and the gateway still serves
  // honest callers after the whole battery.
  const probe = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
  await fsWrite('app', 'probe-fuzz/after.txt', probe);
  const read = await fsRead('app', 'probe-fuzz/after.txt');
  const alive = read.bytes.length === probe.length && read.bytes[0] === probe[0];
  if (!alive) {
    fail('benign roundtrip failed after the battery');
    return;
  }
  emit('fuzz.survived', { benignWrite: true, benignRead: true });

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
};

await main();
