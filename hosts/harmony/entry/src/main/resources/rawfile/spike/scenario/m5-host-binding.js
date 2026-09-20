/**
 * M5 host-binding scenario `m5.host-binding` — runs on the HarmonyOS host
 * where the ArkTS capability layer answers the real dispatch bridge for the
 * platform primitives and the loopback carrier mounts the active Web Client
 * in ArkWeb. Every expected event emits exactly one structured log entry in
 * the order declared by tools/e2e/scenarios/m5-host-binding.json; the
 * carrier's own events (listening / mounted / connected / token deltas /
 * session complete) ride the same canonical stream from the host side as
 * scenario `m5.host-binding` records (module `dsh.carrier`), so ONE manifest
 * covers the whole binding story.
 *
 * Honest v1 surface on this host (descriptor): fsRead/fsWrite/fsScope,
 * notify, presentApproval are REAL; presentPicker, keychainGet/Set,
 * httpFetch are declared `unavailable` and the scenario proves the
 * rejections keep the contract's error shape (absence is information —
 * never faked; ARCHITECTURE.md §12).
 *
 * Live-session proof: after the notification lifecycle the scenario streams
 * a five-delta turn through the bus seam (session-projection@0); the carrier
 * shuttles the projections to the mounted page and logs the first/last delta
 * plus the session-complete marker, evidencing a live session render in
 * ArkWeb on the ONE serial runtime thread.
 */
import { createLogger } from '../logger.js';
import {
  fsRead,
  fsScope,
  fsWrite,
  keychainGet,
  notify,
  onEvent,
  presentApproval,
  presentPicker,
} from '../gateway.js';

const SCENARIO = 'm5.host-binding';
const log = createLogger('m5.spike');
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

/** Session projection push (session-projection@0): one JSON line over the
 * bus seam, shuttled host-side to the carrier WS and rendered by the
 * mounted Web Client. */
const project = (event) => {
  log.debug('projection push', { kind: event.kind });
  globalThis.__dshBusPost?.(JSON.stringify({ type: 'ws.send', payload: event }));
};

const streamDeltas = async (tokens) => {
  project({ kind: 'session', id: 's-m5-0001', scope: 'app' });
  project({ kind: 'agent', model: 'mock-mini', tools: 1 });
  let text = '';
  for (let i = 0; i < tokens.length; i++) {
    await null; // each delta settles on its own runtime-queue tick
    text += tokens[i];
    project({ kind: 'token-delta', index: i, text: tokens[i] });
  }
  return text;
};

const PROBE_PATH = 'm5/binding-probe.txt';
const PROBE = 'dsh-binding-probe'; // exactly 17 ASCII bytes
const probeBytes = () => Uint8Array.from([...PROBE].map((c) => c.charCodeAt(0)));
const bytesEqual = (a, b) => a.length === b.length && [...a].every((v, i) => v === b[i]);

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('gateway.negotiated', { version: 'gateway@1' });

  const descriptor = JSON.parse(globalThis.__dshGatewayDescriptor());
  demand(descriptor.available.length === 5, 'expected 5 available primitives');
  demand(descriptor.unavailable.length === 4, 'expected 4 unavailable primitives');
  emit('descriptor.declared', {
    available: descriptor.available.length,
    unavailable: descriptor.unavailable.length,
  });

  // host.info {"event":"host.info","port":N} — delivered by the carrier
  // embedder once the mounted page's WS connection is live.
  await nextEvent('host.info');

  const written = await fsWrite('app', PROBE_PATH, probeBytes());
  emit('fs.write.ok', { written: written.written });

  const expected = probeBytes();
  const read = await fsRead('app', PROBE_PATH);
  emit('fs.read.ok', { bytes: read.bytes.length, matches: bytesEqual(read.bytes, expected) });

  const approval = await presentApproval({ title: 'E2E approval' });
  demand(approval.approved, 'the driver approves the dialog');
  emit('approval.approved', { approved: approval.approved });

  try {
    await presentPicker({ mode: 'file' });
    demand(false, 'presentPicker is declared unavailable');
  } catch (err) {
    emit('picker.unavailable', { code: err.code });
  }

  try {
    await keychainGet('dsh.spike/cred');
    demand(false, 'keychainGet is declared unavailable');
  } catch (err) {
    emit('keychain.unavailable', { code: err.code });
  }

  // fsScope v1: the app scope persists as a ref that resolves back to it.
  const persisted = await fsScope.persist('app');
  emit('fs.scope.persist', { refOpaque: persisted.ref.startsWith('bkm:') });

  const resolved = await fsScope.resolve(persisted.ref);
  const readBack = await fsRead(resolved.scope, PROBE_PATH);
  emit('fs.scope.resolve', {
    scopeOpaque: typeof resolved.scope === 'string' && resolved.scope.length > 0,
    reads: bytesEqual(readBack.bytes, expected),
  });

  const notification = await notify({ title: 'DSH E2E', body: 'm5 host binding' });
  emit('notify.scheduled', { idOpaque: notification.id.startsWith('n:') });

  const background = await nextEvent('app.state');
  demand(background.state === 'background', 'expected the background edge');
  emit('app.state', { state: background.state });

  const response = await nextEvent('notify.response');
  emit('notify.response', { idMatches: response.id === notification.id });

  const foreground = await nextEvent('app.state');
  demand(foreground.state === 'foreground', 'expected the foreground edge');
  emit('app.state', { state: foreground.state });

  // Live session render: five deltas stream through the carrier into the
  // mounted page; the carrier logs first/last + session-complete evidence.
  await streamDeltas(['Hello', ' live', ' from', ' the', ' carrier']);
  project({ kind: 'complete', status: 'pass', deltas: 5, toolCalls: 0 });

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
}
