/**
 * M5 host-binding scenario `m5.host-binding` — runs on the HarmonyOS host
 * where the ArkTS capability layer answers the real dispatch bridge for ALL
 * NINE contract primitives and the loopback carrier mounts the active Web
 * Client in ArkWeb. Modeled on m4-host-binding.js (the Android twin): after
 * the descriptor + fs legs, the scenario streams the loopback carrier's
 * chunked /gateway-e2e routes through the REAL httpFetch (headers settle →
 * http.body chunk events → end, then an abort mid-body), drives the
 * DocumentViewPicker twice (dismissal → null value; grant → user scope with
 * fsWrite/persist/resolve/read-back), passes the approval dialog, proves
 * the HUKS keychain set/get/delete roundtrip, and closes with the
 * notification lifecycle (background → notify.response → foreground) plus
 * the live five-delta session through the bus seam. Every expected event
 * emits exactly one structured log entry in the order declared by
 * tools/e2e/scenarios/m5-host-binding.json; the carrier's own events
 * (listening / mounted / connected / token deltas / session complete) ride
 * the same canonical stream from the host side as scenario
 * `m5.host-binding` records (module `dsh.carrier`), so ONE manifest covers
 * the whole binding story.
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
  log.debug('stream deltas', { count: tokens.length });
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

const PICKER_MODE = 'file';

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
  demand(descriptor.available.length === 9, 'expected 9 available primitives');
  demand(descriptor.unavailable.length === 0, 'expected 0 unavailable primitives');
  emit('descriptor.declared', {
    available: descriptor.available.length,
    unavailable: descriptor.unavailable.length,
  });

  // host.info {"event":"host.info","port":N} — delivered by the carrier
  // embedder once the mounted page's WS connection is live.
  const hostInfo = await nextEvent('host.info');

  const written = await fsWrite('app', PROBE_PATH, probeBytes());
  emit('fs.write.ok', { written: written.written });

  const expected = probeBytes();
  const read = await fsRead('app', PROBE_PATH);
  emit('fs.read.ok', { bytes: read.bytes.length, matches: bytesEqual(read.bytes, expected) });

  try {
    await fsRead('user:nowhere', 'x'); // ungranted scope must deny
    demand(false, 'ungranted scope should reject denied');
  } catch (err) {
    emit('fs.denied', { code: err.code });
  }

  await httpLeg(`http://127.0.0.1:${hostInfo.port}`);
  await pickerLeg();
  await credentialLeg();
  await lifecycleLeg();
}

/** The notification lifecycle (background → notify.response → foreground)
 * then the live five-delta session through the carrier into the mounted
 * page; the carrier logs first/last + session-complete evidence. */
async function lifecycleLeg() {
  log.debug('lifecycle leg', {});
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

  await streamDeltas(['Hello', ' live', ' from', ' the', ' carrier']);
  project({ kind: 'complete', status: 'pass', deltas: 5, toolCalls: 0 });

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
}

/** httpFetch over the host's own loopback carrier: a chunked byte stream
 * consumed chunk-by-chunk (one event sequence, never a whole result), then
 * an abort mid-body whose iterator rejects `cancelled`. */
async function httpLeg(base) {
  log.debug('http leg', { base });
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

/** presentPicker twice: the driver first cancels the dialog (dismissal is a
 * value — null, nothing granted), then picks the staged user file (the host
 * bootstrap seeds a unique dsh-e2e-seed-*.txt through the platform save
 * dialog — the emulator image ships an empty user store — and delivers its
 * name as the host.seed bridge event). The grant proves the user scope end
 * to end: fsRead of the known bytes through the scope handle, fsScope
 * persist → resolve, and a second read through the resolved handle (the
 * fileIo surface behind user scopes opens picker URIs read-only; creating
 * new doc-provider files needs picker.save, outside this contract's
 * select). */
const SEED = 'dsh-e2e-seed'; // exactly what the host bootstrap wrote

async function pickerLeg() {
  log.debug('picker leg', { dismiss: 'file', grant: PICKER_MODE });

  const dismissed = await presentPicker({ mode: 'file' });
  emit('picker.dismissed', { null: dismissed === null });

  const seed = await nextEvent('host.seed');
  demand(typeof seed.path === 'string' && seed.path.length > 0,
    'the host staged no user-store seed file');
  const seedBytes = () => Uint8Array.from([...SEED].map((c) => c.charCodeAt(0)));

  const picked = await presentPicker({ mode: PICKER_MODE });
  demand(picked, 'picker dismissal is not an E2E path (the driver grants)');
  emit('picker.granted', {
    mode: PICKER_MODE,
    scopeOpaque: typeof picked.scope === 'string' && picked.scope.startsWith('user:'),
    pathOpaque: typeof picked.path === 'string' && picked.path.length > 0,
  });

  const readUser = await fsRead(picked.scope, seed.path);
  emit('fs.user.read', {
    nonEmpty: readUser.bytes.length > 0,
    matches: bytesEqual(readUser.bytes, seedBytes()),
  });

  const persisted = await fsScope.persist(picked.scope);
  emit('fs.scope.persist', { refOpaque: persisted.ref.startsWith('bkm:') });

  const resolved = await fsScope.resolve(persisted.ref);
  const readBack = await fsRead(resolved.scope, seed.path);
  emit('fs.scope.resolve', {
    scopeOpaque: typeof resolved.scope === 'string' && resolved.scope.startsWith('user:'),
    reads: bytesEqual(readBack.bytes, seedBytes()),
  });
}

/** keychain over HUKS: set → get returns identical bytes; set null deletes;
 * the deleted ref reads back null. */
async function credentialLeg() {
  log.debug('credential leg', {});
  const approval = await presentApproval({ title: 'E2E approval' });
  demand(approval.approved, 'the driver approves the dialog');
  emit('approval.approved', { approved: approval.approved });

  const secret = probeBytes();
  await keychainSet('dsh.spike/cred', secret);
  const stored = await keychainGet('dsh.spike/cred');
  emit('keychain.roundtrip', { set: true, match: !!stored && bytesEqual(stored.secret, secret) });

  await keychainSet('dsh.spike/cred', null);
  const gone = await keychainGet('dsh.spike/cred');
  emit('keychain.deleted', { gone: gone === null });
}
