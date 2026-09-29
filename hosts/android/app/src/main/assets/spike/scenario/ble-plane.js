/**
 * BLE-face scenario `ble.plane` (the system capability plane line 3) — runs
 * on iOS, Android and HarmonyOS wherever the privileged layer answers the
 * eight platform-SDK BLE primitives. Every expected event emits exactly one
 * structured log entry through the unified logger, in the order declared by
 * test/e2e/scenarios/{ios,android,harmony}-ble[-mock].json (per-host,
 * per-radio-mode manifests pin the honest surface).
 *
 * Three honest postures, selected by OBSERVED behavior (never by a
 * host-type branch — the scenario reads only what the gateway answers):
 *
 * - `absent` — the radio layer rejects `unavailable` (an emulator without a
 *   Bluetooth radio): the scenario walks the denial legs as values (the
 *   harmony pasteboard posture) and completes. This is the CI skip leg.
 * - `mock` — the host launched its deterministic mock radio: the FULL
 *   ladder runs — scan arm → two advertisement batches → stop → connect →
 *   GATT read/write/subscribe → two notifications → unsubscribe →
 *   disconnect — through the REAL gateway enforcement and the REAL audit
 *   (the envelope + audit CI leg; the radio underneath is named mock in
 *   every pinned device name).
 * - `real` — a live radio with a peer carrying the test GATT db (the D-g
 *   one-click leg, documented in the runners): the same full ladder against
 *   hardware; a peer without the db degrades loudly at the first GATT tuple.
 *
 * Radio support is probed with bleScanStart itself: armed ⇒ live, `unavailable`
 * ⇒ absent. Consent layers are NOT probed here — the caller manifest
 * declares the `ble` family, so the gateway grant holds; the prompt and OS
 * layers are host-side behavior exercised by the real-device legs.
 */
import { createLogger } from '../logger.js';
import {
  bleConnect,
  bleDisconnect,
  bleRead,
  bleScanStart,
  bleScanStop,
  bleSubscribe,
  bleUnsubscribe,
  bleWrite,
  onEvent,
} from '../gateway.js';

const SCENARIO = 'ble.plane';
const log = createLogger('dsh.ble.plane');
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

/** The mock radio's advertised names — pinned by the mock manifests so a
 * manifest can never pass against a radio that is not the named mock. */
const MOCK_NAME_PREFIX = 'DSH Mock BLE';

/** The test GATT db both the mock radio and the documented D-g peer serve:
 * battery-like (180f/2a19, read + notify) and the vendor-test write space
 * (fe00/fe01 write, fe02 notify — unassigned UUID space, deliberately). */
const TUPLE_READ = ['180f', '2a19'];
const TUPLE_WRITE = ['fe00', 'fe01'];
const TUPLE_NOTIFY = ['180f', '2a19'];

/** Collects `ble.event` bridge records; waits are PROMISES resolved by the
 * listener — the arm-then-event discipline with no polling loop and no
 * timers (the spike scenario context has none; the session watchdog bounds
 * every wait, failing the drive loud if the radio misbehaves — rule 8). */
const makeEvents = () => {
  const seen = [];
  const waiters = [];
  const off = onEvent((ev) => {
    if (ev?.event !== 'ble.event') return;
    seen.push(ev);
    for (let i = 0; i < waiters.length; i += 1) {
      if (waiters[i].pred(ev)) {
        const { resolve } = waiters.splice(i, 1)[0];
        resolve(ev);
        break;
      }
    }
  });
  const waitFor = (pred) => new Promise((resolve) => {
    const hit = seen.find(pred);
    if (hit) return resolve(hit);
    waiters.push({ pred, resolve });
    return undefined;
  });
  return { seen, waitFor, stop: off };
};

const opaque = (v) => typeof v === 'string' && v.length > 0;

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('gateway.negotiated', { version: 'gateway@1' });

  const descriptor = JSON.parse(globalThis.__dshGatewayDescriptor());
  const eight = ['bleScanStart', 'bleScanStop', 'bleConnect', 'bleDisconnect',
    'bleRead', 'bleWrite', 'bleSubscribe', 'bleUnsubscribe'];
  const missing = eight.filter((name) => !descriptor.available.includes(name));
  demand(missing.length === 0, `host descriptor lacks the BLE face: ${missing.join(',')}`);
  emit('descriptor.declared', {
    available: descriptor.available.length,
    unavailable: descriptor.unavailable.length,
    blePlane: 8,
  });

  // ---- the radio probe decides the posture ---------------------------------
  // Three honest answers: armed (a live radio), `unavailable` (no radio —
  // a capability gap) and `denied` (the OS layer refused — e.g. an emulator
  // whose virtual radio is up while the runtime permissions are not
  // granted). All three are values; the manifests pin each host's posture.
  const events = makeEvents();
  let scanId = null;
  let probeCode = '';
  try {
    const armed = await bleScanStart({ timeoutMs: 4000, tag: 'ble-plane-probe' });
    scanId = armed?.scanId ?? null;
  } catch (err) {
    probeCode = err.code ?? '';
  }

  if (scanId === null) {
    // ---- the honest skip: the radio layer cannot serve this host ----------
    demand(probeCode === 'unavailable' || probeCode === 'denied',
      `the radio probe must arm or answer unavailable/denied (got ${probeCode})`);
    const denied = probeCode === 'denied';
    emit('ble.radio', denied ? { mode: 'denied', layer: 'os' } : { mode: 'absent' });
    emit(denied ? 'ble.scan.denied' : 'ble.scan.unavailable', { code: probeCode });
    const stop = await bleScanStop('scan:none');
    demand(stop.stopped === false, 'an unknown scanId must stop nothing');
    emit('ble.stop.idempotent', { stopped: false });
    let connectCode = '';
    try {
      await bleConnect('device:none');
    } catch (err) {
      connectCode = err.code ?? '';
    }
    demand(connectCode === probeCode,
      `connect without a radio must reject ${probeCode} (got ${connectCode || 'a null resolve'})`);
    emit(denied ? 'ble.connect.denied' : 'ble.connect.unavailable', { code: connectCode });
    const disc = await bleDisconnect('conn:none');
    demand(disc.closed === false, 'an unknown connectionId must close nothing');
    emit('ble.disconnect.idempotent', { closed: false });
    events.stop();
    emit('scenario.complete', { status: 'pass' });
    globalThis.__dshComplete(true, 'ok');
  } else {
    // ---- the live ladder (mock in CI, real hardware on the D-g legs) ------
    demand(opaque(scanId), 'scanId must be an opaque non-empty token');
    emit('ble.radio', { mode: 'live' });
    emit('ble.scan.armed', { scanIdOpaque: true, tag: 'ble-plane-probe' });

    // Devices arrive as events while the scan is armed — awaited, never
    // polled (D8). The mock radios deliver a TWO-device batch: when the
    // first arrival carries the mock name prefix, the scenario waits for
    // its sibling (each bridge event is a separate serial-queue hop, so a
    // single await can race the burst). A real peer advertises at least
    // once (the D-g legs require it).
    await events.waitFor((ev) => ev.kind === 'device' && ev.scanId === scanId);
    const first = events.seen.find((ev) => ev.kind === 'device'
      && ev.scanId === scanId);
    const firstIsMock = typeof first?.name === 'string'
      && first.name.startsWith(MOCK_NAME_PREFIX);
    if (firstIsMock) {
      await events.waitFor((ev) => ev.kind === 'device'
        && ev.scanId === scanId && ev.deviceId !== first.deviceId);
    }
    const devices = events.seen.filter((ev) => ev.kind === 'device'
      && ev.scanId === scanId);
    demand(devices.length > 0, 'no advertisement arrived while the scan was armed');
    for (const dev of devices) {
      demand(opaque(dev.deviceId), 'deviceId must be an opaque non-empty token');
      emit('ble.device', {
        deviceIdOpaque: true,
        namePresent: typeof dev.name === 'string' && dev.name.length > 0,
        name: dev.name ?? '',
        rssi: dev.rssi,
      });
    }

    const stopped = await bleScanStop(scanId);
    demand(stopped.stopped === true, 'the live scan must stop');
    emit('ble.scan.stopped', { stopped: true });

    // The first-seen device is the connect target (mock order is
    // deterministic; the D-g peer is the only advertiser by contract).
    const target = devices[0];
    const isMock = firstIsMock;
    const connection = await bleConnect(target.deviceId);
    demand(connection !== null, `the peer walked away: ${target.deviceId}`);
    const connectionId = connection.connectionId;
    demand(opaque(connectionId), 'connectionId must be an opaque non-empty token');
    emit('ble.connect', { connectionIdOpaque: true });

    // ---- the GATT ladder ----------------------------------------------------
    // The mock (and the documented D-g peer) serves the test db; a peer
    // without it degrades LOUDLY at the first tuple (fail loud, rule 5 —
    // the degraded leg is a documented operator error, never a silent pass).
    let gattOk = true;
    try {
      const read = await bleRead(connectionId, TUPLE_READ[0], TUPLE_READ[1]);
      demand(read.bytes instanceof Uint8Array && read.bytes.length > 0,
        'the read must answer bytes');
      emit('ble.read', { bytes: read.bytes.length });

      const written = await bleWrite(connectionId, TUPLE_WRITE[0], TUPLE_WRITE[1],
        Uint8Array.from([1, 2, 3]), { response: true });
      demand(written.written === true, 'the write must be accepted');
      emit('ble.write', { written: true, bytes: 3 });

      const sub = await bleSubscribe(connectionId, TUPLE_NOTIFY[0], TUPLE_NOTIFY[1]);
      demand(sub.subscribed === true, 'the subscribe must arm');
      emit('ble.subscribed', { subscribed: true });

      // Notifications arrive as events — two for the mock db and the
      // documented peer; each is awaited (D8), the watchdog bounds the wait.
      for (let n = 1; n <= 2; n += 1) {
        const hit = await events.waitFor((ev) => ev.kind === 'notify'
          && ev.connectionId === connectionId
          && ev.service === TUPLE_NOTIFY[0]
          && ev.characteristic === TUPLE_NOTIFY[1]);
        events.seen.splice(events.seen.indexOf(hit), 1);
        const size = hit.bytesB64
          ? atobBytesLength(hit.bytesB64)
          : (hit.bytes?.length ?? 0);
        emit('ble.notify', { seq: n, bytes: size });
      }

      const unsub = await bleUnsubscribe(connectionId, TUPLE_NOTIFY[0], TUPLE_NOTIFY[1]);
      demand(unsub.subscribed === false, 'the unsubscribe must disarm');
      emit('ble.unsubscribed', { subscribed: false });
    } catch (err) {
      gattOk = false;
      emit('ble.gatt.degraded', { code: err.code, peer: isMock ? 'mock' : 'real' });
      demand(false, `the GATT ladder degraded (${err.code}) — the peer lacks the test db`);
    }

    const closed = await bleDisconnect(connectionId);
    demand(closed.closed === true, 'the live disconnect must close');
    emit('ble.disconnected', { closed: true, gatt: gattOk });

    events.stop();
    emit('scenario.complete', { status: 'pass' });
    globalThis.__dshComplete(true, 'ok');
  }
}

/** Base64 payload length without pulling a decoder dependency: the frozen
 * bridge convention encodes bytes as "<key>B64"; every 4 output chars carry
 * 3 bytes and each pad char marks one byte fewer in the tail group. */
function atobBytesLength(b64) {
  const pads = (String(b64).match(/=+$/) ?? [''])[0].length;
  return Math.floor(String(b64).length * 3 / 4) - pads;
}
