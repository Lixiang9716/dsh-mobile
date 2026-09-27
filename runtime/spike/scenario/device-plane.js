/**
 * Device-plane scenario `device.plane` (contract v1.5.0) — runs on iOS,
 * Android and HarmonyOS where the privileged layers answer the six
 * platform-SDK primitives. Every expected event emits exactly one
 * structured log entry through the unified logger, in the order declared by
 * test/e2e/scenarios/{device-plane,android-device-plane,
 * harmony-device-plane}.json (per-platform counts pin each host's
 * descriptor).
 *
 * Drives the surface in a FIXED call order so the flat audit stream
 * ({primitive,verdict,outcome} rows) is one-to-one too: descriptor
 * conformance, deviceInfo, the nine haptic patterns, the clipboard
 * write→read approval roundtrip (once / remember / standing grant),
 * presentShare files through the app scope + an ungranted-scope denial,
 * keepAwake hold/release, and finally the media picker leg (grant or
 * dismissal — each host's driver taps what its picker automates; the
 * manifest pins the per-host outcome, and the grant path reads back the
 * picked media through the granted scope).
 */
import { createLogger } from '../logger.js';
import {
  clipboardRead,
  clipboardWrite,
  deviceInfo,
  fsRead,
  fsWrite,
  haptic,
  keepAwake,
  presentPicker,
  presentShare,
} from '../gateway.js';

const SCENARIO = 'device.plane';
const log = createLogger('dsh.device.plane');
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

const PROBE = 'dsh-clipboard-probe';
const HAPTIC_PATTERNS = [
  'light', 'medium', 'heavy', 'rigid', 'soft',
  'selection', 'success', 'warning', 'error',
];

if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('gateway.negotiated', { version: 'gateway@1' });

  const descriptor = JSON.parse(globalThis.__dshGatewayDescriptor());
  const six = ['deviceInfo', 'haptic', 'clipboardRead', 'clipboardWrite', 'presentShare', 'keepAwake'];
  const missing = six.filter((name) => !descriptor.available.includes(name));
  demand(missing.length === 0, `host descriptor lacks the device plane: ${missing.join(',')}`);
  emit('descriptor.declared', {
    available: descriptor.available.length,
    unavailable: descriptor.unavailable.length,
    devicePlane: 6,
  });

  // ---- deviceInfo ----------------------------------------------------------
  const info = await deviceInfo();
  demand(info.screen.width > 0 && info.screen.height > 0, 'screen facts are empty');
  demand(info.locale.length > 0 && info.timezone.length > 0, 'locale/timezone are empty');
  emit('device.info', {
    platform: info.platform,
    screen: info.screen.width > 0 && info.screen.height > 0,
    locale: info.locale.length > 0,
    timezone: info.timezone.length > 0,
    battery: info.battery !== undefined,
  });

  // ---- haptic: the whole closed vocabulary resolves (or is honestly
  // unavailable — an emulator without a vibrator rejects; a real device
  // delivers the cue) ----------------------------------------------
  let unavailable = 0;
  for (const pattern of HAPTIC_PATTERNS) {
    try {
      await haptic(pattern);
    } catch (err) {
      demand(err.code === 'unavailable', `haptic ${pattern} failed: ${err.code}`);
      unavailable += 1;
    }
  }
  emit('haptic.series', { patterns: HAPTIC_PATTERNS.length, unavailable });

  // ---- clipboard: write, then the approval-gated reads. Where the
  // platform pasteboard is non-functional (an emulator image can be), the
  // host rejects `unavailable` — a capability gap, not an error — and the
  // scenario walks the APPROVAL ladder without the content assertions
  // (the approval gate is the security surface; the content roundtrip is
  // the pasteboard's). ----------------------------------------------
  let clipboardWorks = true;
  try {
    await clipboardWrite(PROBE);
  } catch (err) {
    demand(err.code === 'unavailable', `clipboardWrite failed: ${err.code}`);
    clipboardWorks = false;
  }
  if (!clipboardWorks) {
    // the ladder still runs its THREE approval gates (the security surface)
    for (let i = 0; i < 3; i++) {
      const step = await clipboardRead();
      demand(step === null || typeof step.text === 'string', 'read shape');
    }
    emit('clipboard.written', { length: 0, unavailable: true });
    emit('clipboard.ladder', { approvals: 3 });
  } else {
    emit('clipboard.written', { length: PROBE.length, unavailable: false });
    const first = await clipboardRead();
    demand(first !== null && first.text === PROBE, 'clipboard read (approve) mismatched');
    emit('clipboard.read', { match: first.text === PROBE });
    const second = PROBE.slice(0, 9);
    await clipboardWrite(second);
    const remembered = await clipboardRead();
    demand(remembered !== null && remembered.text === second, 'clipboard read (remember) mismatched');
    emit('clipboard.remember', { match: remembered.text === second });
    const standing = await clipboardRead();
    demand(standing !== null && standing.text === second, 'clipboard read (standing) mismatched');
    emit('clipboard.standing', { match: standing.text === second });
  }

  // ---- presentShare: the sheet is its own consent ----------------------------
  const shareBytes = Uint8Array.from([...PROBE].map((c) => c.charCodeAt(0)));
  await fsWrite('app', 'share-e2e.txt', shareBytes);
  const share = await presentShare({ kind: 'files', paths: ['app:share-e2e.txt'] });
  // The sheet PRESENTED means the granted path resolved (a failed scope
  // resolution rejects denied before any UI); whether the driver completes
  // the sheet or walks away, the value is the point.
  emit('share.files.completed', { shared: share.shared });

  const textShare = await presentShare({ kind: 'text', text: PROBE });
  emit('share.text.completed', { shared: textShare.shared });

  try {
    await presentShare({ kind: 'files', paths: ['user:nowhere:x'] });
    demand(false, 'ungranted share path should reject denied');
  } catch (err) {
    emit('share.denied', { code: err.code });
  }

  // ---- keepAwake: the boolean latch ------------------------------------------
  await keepAwake(true);
  emit('keepawake.hold', { hold: true });
  await keepAwake(false);
  emit('keepawake.release', { hold: false });

  // ---- the media picker leg (last: the audit tail stays deterministic) --------
  const media = await presentPicker({ mode: 'media' });
  if (media === null) {
    // user dismissal is a value — each host's driver picks the path its
    // picker automates deterministically
    emit('picker.media.cancelled', { mode: 'media' });
  } else {
    demand(media.scope.length > 0, 'media grant carries no scope');
    emit('picker.media.granted', {
      mode: 'media',
      scopeOpaque: media.scope.startsWith('user:') || media.scope === 'app',
      pathOpaque: typeof media.path === 'string' && media.path.length > 0,
    });
    const bytes = await fsRead(media.scope, media.path);
    emit('picker.media.read', { bytes: bytes.bytes.length, reads: bytes.bytes.length > 0 });
  }

  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'ok');
}
