/**
 * M4 host-binding scenario `android.capability-binding` — runs on Android where the
 * Kotlin embedder answers the dispatch bridge with all nine primitives and
 * the loopback carrier mounts the Web Client in a real WebView. Modeled on
 * gateway-binding.js + session-mock-llm.js: descriptor conformance, the
 * carrier mount + session leg (token deltas streamed into the page), then
 * fs roundtrip + ungranted-scope denial, chunked httpFetch body + abort,
 * picker grant → fsScope persist/resolve roundtrip, approval dialog,
 * keychain set/get/delete roundtrip over the Android Keystore, and the
 * notification → background → notify.response → foreground lifecycle (the
 * embedder delivers those bridge events in order through
 * dsh_spike_gateway_event). Every expected event emits exactly one
 * structured log entry, in the order declared by
 * tools/e2e/scenarios/android-capability-binding.json — the carrier-side records
 * (mounted / connected / slot / deltas / session-complete) come from the
 * host under the SAME scenario id, so one manifest matches the whole flow.
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

const SCENARIO = 'android.capability-binding';
const log = createLogger('m4.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  log.debug('scenario failed', { reason });
  emit('scenario.failed', { reason });
  globalThis.__dshComplete(false, reason);
};
const demand = (cond, reason) => {
  if (cond) return;
  log.debug('demand failed', { reason });
  fail(reason);
  throw new Error(reason);
};

/** Session projection push (session-projection@0): one JSON line over the
 * bus seam, shuttled host-side to the carrier WS and rendered by the
 * mounted Web Client. */
const project = (event) => {
  log.debug('projection push', { kind: event.kind });
  globalThis.__dshBusPost?.(JSON.stringify({ type: 'ws.send', payload: event }));
};

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
  log.debug('wait for event', { name });
  for (;;) {
    const at = buffered.findIndex((ev) => ev.event === name);
    if (at >= 0) return buffered.splice(at, 1)[0];
    const ev = await new Promise((resolve) => waiters.push(resolve));
    buffered.push(ev);
  }
};

/* Bus messages (the m1 carrier seam) consumed the same way. */
const busBuffered = [];
const busWaiters = [];
globalThis.__dshBusOnMessage = (line) => {
  const msg = JSON.parse(line);
  const wake = busWaiters.shift();
  if (wake) wake(msg);
  else busBuffered.push(msg);
};
const nextBus = async (type) => {
  log.debug('wait for bus message', { type });
  for (;;) {
    const at = busBuffered.findIndex((msg) => msg.type === type);
    if (at >= 0) return busBuffered.splice(at, 1)[0];
    const msg = await new Promise((resolve) => busWaiters.push(resolve));
    busBuffered.push(msg);
  }
};

/** Announce the bus subscription: the host answers with host.hello (the
 * carrier port), delivered after eval returns (posted, never reentrant). */
globalThis.__dshBusPost?.(JSON.stringify({ type: 'bus.ready' }));

const PROBE = 'dsh-gateway-probe'; // exactly 17 ASCII bytes
const probeBytes = () => Uint8Array.from([...PROBE].map((c) => c.charCodeAt(0)));
const bytesEqual = (a, b) => a.length === b.length && [...a].every((v, i) => v === b[i]);
const SESSION_ID = 's-m4-0001';
const TURN_ONE = ['Host', ' binding'];

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  main().catch((err) => fail(`unhandled: ${err?.message ?? err}`));
}

/** The scenario body: every await rejection lands in the catch above and
 * fails loud — a stalled promise must never masquerade as a hang. */
async function main() {
  log.debug('scenario main', { descriptor: 'gateway@1' });
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

  // Toolbar slot projected BEFORE the page connects: the host buffers the
  // projection and replays it on connect, so the page renders (and acks)
  // the slot ahead of everything else — the rendered-state evidence.
  project({ kind: 'slot.register', id: 'm4.toolbar', label: 'host', by: 'android-capability-binding' });

  const hello = await nextBus('host.hello');
  demand(Number.isInteger(hello.port) && hello.port > 0, 'carrier delivered no usable port');
  emit('carrier.listening', { transport: 'tcp', loopback: true });

  // host.info {"event":"host.info","port":N} — delivered by the embedder
  // only once the page is mounted, connected, AND acked the toolbar slot.
  const hostInfo = await nextEvent('host.info');
  emit('host.ready', { signalled: true });

  await sessionLeg();
  await bindingFsLeg(`http://127.0.0.1:${hostInfo.port}`);
  await bindingUiLeg();

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
}

/** Session leg: token deltas stream live into the mounted page. */
async function sessionLeg() {
  log.debug('session leg', { sessionId: SESSION_ID });
  emit('session.created', { sessionId: SESSION_ID, scope: 'app' });
  project({ kind: 'session', id: SESSION_ID, scope: 'app' });
  emit('agent.started', { model: 'mock-mini', tools: 1 });
  project({ kind: 'agent', model: 'mock-mini', tools: 1 });
  emit('llm.stream.started', { turn: 1 });
  let index = 0;
  for (const token of TURN_ONE) {
    await null; // each delta settles on its own runtime-queue tick
    emit('llm.delta', { index, text: token });
    project({ kind: 'token-delta', index, text: token });
    index += 1;
  }
  emit('llm.stream.completed', { turn: 1, deltas: TURN_ONE.length, toolCalls: 0 });
  emit('session.completed', {
    sessionId: SESSION_ID,
    status: 'pass',
    deltas: TURN_ONE.length,
    toolCalls: 0,
  });
  project({ kind: 'complete', status: 'pass', deltas: TURN_ONE.length, toolCalls: 0 });
}

/** Binding leg over fs + the loopback httpFetch surface. */
async function bindingFsLeg(base) {
  log.debug('binding fs/http leg', { base });

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
}

/** Binding leg over the UI-driven surfaces + credentials + notifications. */
async function bindingUiLeg() {
  log.debug('binding ui leg', { picker: 'directory' });

  const picked = await presentPicker({ mode: 'directory' });
  demand(picked, 'picker dismissal is not an E2E path (the driver grants dsh-e2e)');
  emit('picker.granted', { mode: 'directory', scopeOpaque: picked.scope.startsWith('user:') });

  const persisted = await fsScope.persist(picked.scope);
  emit('fs.scope.persist', { refOpaque: persisted.ref.startsWith('bkm:') });

  const resolved = await fsScope.resolve(persisted.ref);
  const readBack = await fsRead(resolved.scope, 'notes.txt');
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

  const notification = await notify({ title: 'DSH E2E', body: 'm4 host binding' });
  emit('notify.scheduled', { idOpaque: notification.id.startsWith('n:') });

  const background = await nextEvent('app.state');
  emit('app.state', { state: background.state });

  const response = await nextEvent('notify.response');
  emit('notify.response', { idMatches: response.id === notification.id });

  const foreground = await nextEvent('app.state');
  emit('app.state', { state: foreground.state });
}
