/**
 * M2 gateway-binding scenario `m2.gateway.binding` — runs on iOS where the
 * Swift embedder answers the real dispatch bridge with all nine primitives.
 * Every expected event emits exactly one structured log entry through the
 * unified logger, in the order declared by
 * tools/e2e/scenarios/m2-gateway-binding.json.
 *
 * Drives the frozen 19-event list in order: descriptor conformance, fs
 * roundtrip + ungranted-scope denial, chunked httpFetch body + abort,
 * picker grant → fsScope persist/resolve roundtrip, approval dialog,
 * keychain set/get/delete roundtrip, and the notification → background →
 * notify.response → foreground lifecycle (the embedder delivers those
 * bridge events in order through dsh_spike_gateway_event).
 */
import { createLogger } from '../logger.js';
import {
  fsRead,
  fsScope,
  fsWrite,
  httpFetch,
  keychainGet,
  keychainSet,
  notify,
  onEvent,
  presentApproval,
  presentPicker,
} from '../gateway.js';

const SCENARIO = 'm2.gateway.binding';
const log = createLogger('m2.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  emit('scenario.failed', { reason });
  globalThis.__dshComplete(false, reason);
};
const demand = (cond, reason) => {
  if (cond) return;
  fail(reason);
  throw new Error(reason);
};

const PROBE = 'dsh-gateway-probe'; // exactly 17 ASCII bytes
const probeBytes = () => Uint8Array.from([...PROBE].map((c) => c.charCodeAt(0)));
const bytesEqual = (a, b) => a.length === b.length && [...a].every((v, i) => v === b[i]);

/* Bridge events arrive in embedder order; the scenario consumes them by
 * name, buffering anything that arrives while it waits for another kind. */
const buffered = [];
const waiters = [];
onEvent((ev) => {
  const wake = waiters.shift();
  if (wake) wake(ev);
  else buffered.push(ev);
});
const nextEvent = async (name) => {
  for (;;) {
    const at = buffered.findIndex((ev) => ev.event === name);
    if (at >= 0) return buffered.splice(at, 1)[0];
    const ev = await new Promise((resolve) => waiters.push(resolve));
    buffered.push(ev);
  }
};

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('gateway.negotiated', { version: 'gateway@1' });

  const descriptor = JSON.parse(globalThis.__dshGatewayDescriptor());
  demand(
    descriptor.unavailable.length === 0,
    `host declared unavailable primitives: ${descriptor.unavailable.join(',')}`,
  );
  emit('descriptor.declared', {
    available: descriptor.available.length,
    unavailable: descriptor.unavailable.length,
  });

  // host.info {"event":"host.info","port":N} — delivered by the embedder.
  const hostInfo = await nextEvent('host.info');
  const base = `http://127.0.0.1:${hostInfo.port}`;

  const written = await fsWrite('app', 'probe.txt', probeBytes());
  emit('fs.write.ok', { written: written.written });

  const expected = probeBytes();
  const read = await fsRead('app', 'probe.txt');
  emit('fs.read.ok', { bytes: read.bytes.length, matches: bytesEqual(read.bytes, expected) });

  try {
    await fsRead('user:nowhere', 'x'); // ungranted scope must deny
    demand(false, 'ungranted scope should reject denied');
  } catch (err) {
    emit('fs.denied', { code: err.code });
  }

  const bytesRes = await httpFetch(`${base}/gateway-e2e/bytes`);
  emit('http.status', { status: bytesRes.status, loopback: base.startsWith('http://127.0.0.1:') });

  let chunks = 0;
  let totalBytes = 0;
  for await (const chunk of bytesRes.body) {
    chunks += 1;
    totalBytes += chunk.length;
  }
  emit('http.body', { chunks, totalBytes });

  const slow = await httpFetch(`${base}/gateway-e2e/slow`);
  let seen = 0;
  try {
    for await (const chunk of slow.body) {
      seen += 1;
      if (seen === 1) slow.abort(); // abort after the first chunk
    }
    demand(false, 'aborted body should throw cancelled');
  } catch (err) {
    emit('http.aborted', { code: err.code });
  }

  const picked = await presentPicker({ mode: 'file' });
  demand(picked, 'picker dismissal is not an E2E path (the driver grants notes.txt)');
  emit('picker.granted', {
    mode: 'file',
    path: picked.path,
    scopeOpaque: picked.scope.startsWith('user:'),
  });

  const persisted = await fsScope.persist(picked.scope);
  emit('fs.scope.persist', { refOpaque: persisted.ref.startsWith('bkm:') });

  const resolved = await fsScope.resolve(persisted.ref);
  const readBack = await fsRead(resolved.scope, picked.path);
  emit('fs.scope.resolve', {
    scopeOpaque: resolved.scope.startsWith('user:'),
    reads: readBack.bytes.length > 0,
  });

  const approval = await presentApproval({ title: 'E2E approval' });
  emit('approval.approved', { approved: approval.approved, remember: approval.remember ?? false });

  const secret = globalThis.crypto.getRandomValues(new Uint8Array(32));
  await keychainSet('dsh.spike/cred', secret);
  const stored = await keychainGet('dsh.spike/cred');
  emit('keychain.roundtrip', { set: true, match: !!stored && bytesEqual(stored.secret, secret) });

  await keychainSet('dsh.spike/cred', null);
  const gone = await keychainGet('dsh.spike/cred');
  emit('keychain.deleted', { gone: gone === null });

  const notification = await notify({ title: 'DSH E2E', body: 'gateway binding' });
  emit('notify.scheduled', { idOpaque: notification.id.startsWith('n:') });

  const background = await nextEvent('app.state');
  emit('app.state', { state: background.state });

  const response = await nextEvent('notify.response');
  emit('notify.response', { idMatches: response.id === notification.id });

  const foreground = await nextEvent('app.state');
  emit('app.state', { state: foreground.state });

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
}
