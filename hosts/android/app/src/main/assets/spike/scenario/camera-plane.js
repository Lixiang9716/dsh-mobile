/**
 * Camera-plane scenario `camera.plane` (the system capability plane,
 * proposal v1.10.0 — the camera family's v1 implementation face). Runs on
 * iOS, Android and HarmonyOS wherever the privileged layer answers
 * `cameraCapture`. Every expected event emits exactly one structured log
 * entry through the unified logger, in the order declared by
 * test/e2e/scenarios/{camera-plane,android-camera-plane,
 * harmony-camera-plane}.json (per-platform manifests pin each host's
 * honest surface: a simulator without a camera walks the denial legs
 * without content assertions — the harmony pasteboard posture — while a
 * host with a camera really captures and reads the frames back).
 *
 * Drives the surface in a FIXED call order so the flat audit stream
 * ({primitive,verdict,outcome} rows) is one-to-one too: descriptor
 * conformance (cameraCapture declared available, the two PHASED recording
 * rows declared unavailable), the phased rows' unavailable answers, then
 * the capture burst: two frames, read back through the granted scope (the
 * byte counts must match — the audit carries counts, never pixels), and a
 * maxBytes leg proving an over-cap frame is dropped, not truncated.
 */
import { createLogger } from '../logger.js';
import {
  cameraCapture,
  cameraRecordStart,
  cameraRecordStop,
  fsRead,
} from '../gateway.js';

const SCENARIO = 'camera.plane';
const log = createLogger('dsh.camera.plane');
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
/* The phased rows' rejection is the EXPECTED shape; anything else is loud. */
const demandUnavailable = async (call, what) => {
  try {
    await call();
    demand(false, `${what} should reject unavailable (phased shape)`);
  } catch (err) {
    demand(err.code === 'unavailable', `${what} rejected ${err.code}: ${err.message ?? ''}`);
  }
};

log.debug('scenario start', { scenario: SCENARIO });

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('gateway.negotiated', { version: 'gateway@1' });

  // ---- descriptor conformance: the camera rows are declared honestly -------
  const descriptor = JSON.parse(globalThis.__dshGatewayDescriptor());
  demand(descriptor.available.includes('cameraCapture'),
    'host descriptor lacks cameraCapture');
  const PHASED = ['cameraRecordStart', 'cameraRecordStop'];
  const notPhased = PHASED.filter((name) => !descriptor.unavailable.includes(name));
  demand(notPhased.length === 0, `descriptor must declare the phased rows unavailable: ${notPhased.join(',')}`);
  emit('descriptor.camera', { capture: true, phased: PHASED.length });

  // ---- the phased recording rows answer unavailable (shape now, the
  // implementation follows as its own change) ---------------------------------
  await demandUnavailable(() => cameraRecordStart({ maxDurationMs: 3000, withAudio: false }),
    'cameraRecordStart');
  emit('record.unavailable', { code: 'unavailable' });
  await demandUnavailable(() => cameraRecordStop('t-e2e-0'), 'cameraRecordStop');
  emit('record.stop.unavailable', { code: 'unavailable' });

  // ---- the capture burst (last: the audit tail stays deterministic) ---------
  // Refusal at either consent layer resolves null; a host with no camera
  // rejects `unavailable` — a capability gap negotiation should have caught,
  // walked here without content assertions (a simulator's honest posture).
  let burst = null;
  let unavailableCode = null;
  try {
    burst = await cameraCapture({ count: 2, format: 'jpeg', flash: 'off', tag: 'e2e' });
  } catch (err) {
    demand(err.code === 'unavailable', `cameraCapture rejected ${err.code}: ${err.message ?? ''}`);
    unavailableCode = err.code;
  }
  if (unavailableCode !== null) {
    emit('capture.unavailable', { code: unavailableCode });
  } else if (burst === null) {
    emit('capture.refused', {});
  } else {
    const photos = burst.photos;
    demand(photos.length === 2, `burst count mismatch: ${photos.length}`);
    const shaped = photos.every((p) => p.format === 'jpeg' && p.bytes > 0
      && p.width > 0 && p.height > 0 && !Number.isNaN(Date.parse(p.capturedAt))
      && typeof p.scope === 'string' && p.scope.length > 0
      && typeof p.path === 'string' && p.path.length > 0);
    demand(shaped, 'photo shape violated (format/bytes/dimensions/timestamp/scope)');
    emit('capture.burst', {
      count: photos.length,
      formatOk: true,
      sizedOk: true,
      stampedOk: true,
    });
    // The pixels are ordinary files: read each frame back through the
    // granted scope and demand the byte counts line up (the audit carries
    // the numbers, the scope carries the bytes).
    let matched = 0;
    for (const photo of photos) {
      const file = await fsRead(photo.scope, photo.path);
      demand(file.bytes.length === photo.bytes,
        `readback bytes mismatch: ${file.bytes.length} vs ${photo.bytes}`);
      matched += 1;
    }
    emit('capture.readback', { frames: matched, matched: true });
    // maxBytes is a DROP cap, never a truncation: a one-byte cap drops every
    // real frame, and the burst resolves with zero photos.
    const dropped = await cameraCapture({ count: 2, maxBytes: 1, format: 'jpeg', tag: 'e2e-maxbytes' });
    demand(dropped !== null && dropped.photos.length === 0,
      `over-cap frames must be dropped, got ${dropped === null ? 'null' : dropped.photos.length}`);
    emit('capture.maxbytes', { photos: dropped.photos.length, dropped: true });
  }

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
}
