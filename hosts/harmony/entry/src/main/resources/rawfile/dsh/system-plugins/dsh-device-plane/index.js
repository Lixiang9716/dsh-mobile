/**
 * dsh-device-plane — system implementation plugin for the `device` service
 * (contract v1.5.0).
 *
 * Platform-neutral: consumes ONLY the frozen contract primitives (the six
 * device-plane rows via the runtime/dsh gateway shim) and the unified
 * logger. The security-bearing behavior lives host-side — clipboardRead's
 * approval gate, presentShare's sheet-as-consent, share files' scope
 * discipline — this plugin adds input validation and a small typed surface
 * above the raw shim. A host without a primitive rejects `unavailable`;
 * callers treat that as a capability gap (contract/primitives.md §3), which
 * is why every call here rethrows GatewayError untouched.
 */
import { createLogger } from 'logger.js';
import { deviceInfo, haptic, clipboardRead, clipboardWrite, presentShare, keepAwake, GatewayError } from 'gateway.js';

const log = createLogger('dsh.device');

/** The static manifest this plugin installs under (schemaVersion 1). */
export const manifest = {
  schemaVersion: 1,
  id: 'dsh-device-plane',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: {
    required: ['deviceInfo', 'haptic', 'clipboardRead', 'clipboardWrite', 'presentShare', 'keepAwake'],
    optional: [],
  },
  hooks: { activate: 'activate' },
};

/** The closed haptic vocabulary (contract §4 device plane). */
const HAPTIC_PATTERNS = ['light', 'medium', 'heavy', 'rigid', 'soft', 'selection', 'success', 'warning', 'error'];

const assertPattern = (pattern) => {
  log.debug('pattern check', { pattern });
  if (!HAPTIC_PATTERNS.includes(pattern)) {
    throw new GatewayError('invalid', 'haptic', `unknown haptic pattern: ${pattern}`);
  }
};

const assertText = (text, primitive) => {
  log.debug('text check', { primitive, chars: text?.length });
  if (typeof text !== 'string') {
    throw new GatewayError('invalid', primitive, `${primitive} expects a string`);
  }
};

/** The closed share payload vocabulary; files paths stay opaque here — the
 * host re-checks the scope discipline (outside a granted scope is denied). */
const assertPayload = (payload) => {
  log.debug('payload check', { kind: payload?.kind });
  const ok = payload && (payload.kind === 'text' || payload.kind === 'url' || payload.kind === 'files');
  if (!ok) throw new GatewayError('invalid', 'presentShare', 'share payload kind must be text | url | files');
  if (payload.kind === 'text' && typeof payload.text !== 'string') {
    throw new GatewayError('invalid', 'presentShare', 'text payload expects a string');
  }
  if (payload.kind === 'url' && typeof payload.url !== 'string') {
    throw new GatewayError('invalid', 'presentShare', 'url payload expects a string');
  }
  if (payload.kind === 'files' && (!Array.isArray(payload.paths) || payload.paths.some((p) => typeof p !== 'string'))) {
    throw new GatewayError('invalid', 'presentShare', 'files payload expects an array of paths');
  }
};

/** Activation hook (manifest.hooks.activate): registers the `device` service. */
export function activate({ register }) {
  log.debug('activating dsh-device-plane');

  const info = async () => {
    log.debug('device.info');
    return await deviceInfo();
  };

  const buzz = async (pattern) => {
    log.debug('device.haptic', { pattern });
    assertPattern(pattern);
    await haptic(pattern);
  };

  const pasteboardRead = async () => {
    log.debug('device.clipboardRead');
    return await clipboardRead();
  };

  const pasteboardWrite = async (text) => {
    log.debug('device.clipboardWrite', { chars: text?.length });
    assertText(text, 'clipboardWrite');
    await clipboardWrite(text);
  };

  const share = async (payload) => {
    log.debug('device.share');
    assertPayload(payload);
    return await presentShare(payload);
  };

  const setAwake = async (hold) => {
    log.debug('device.keepAwake', { hold: !!hold });
    await keepAwake(!!hold);
  };

  register('device', {
    info,
    haptic: buzz,
    clipboardRead: pasteboardRead,
    clipboardWrite: pasteboardWrite,
    share,
    keepAwake: setAwake,
  });
}
