/**
 * dsh-ble — system implementation plugin for the `ble` service (the system
 * capability plane, BLE face: contract/proposals/
 * 2026-09-30-system-capability-plane.md §6-7).
 *
 * Platform-neutral: consumes ONLY the eight BLE gateway primitives via the
 * runtime/spike gateway shim and the unified logger. The security-bearing
 * behavior lives host-side — the two consent layers (gateway prompt first,
 * OS permission second), the opaque device/connection tokens, the audit
 * trail with direction + byte counts (never payload bytes) — this plugin
 * adds typed validation and one event tap above the raw shim. A host
 * without the plane rejects `unavailable`; callers treat that as a
 * capability gap (contract/primitives.md §3), which is why every call here
 * rethrows GatewayError untouched.
 */
import { createLogger } from 'logger.js';
import {
  bleScanStart,
  bleScanStop,
  bleConnect,
  bleDisconnect,
  bleRead,
  bleWrite,
  bleSubscribe,
  bleUnsubscribe,
  onEvent,
  GatewayError,
} from 'gateway.js';

const log = createLogger('dsh.ble');

/** The static manifest this plugin installs under (schemaVersion 1). */
export const manifest = {
  schemaVersion: 1,
  id: 'dsh-ble',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: {
    required: ['ble'],
    optional: [],
  },
  hooks: { activate: 'activate' },
};

const assertToken = (value, what) => {
  log.debug('token check', { what, chars: value?.length });
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayError('invalid', what, `${what} expects a non-empty opaque token string`);
  }
};

const assertUuid = (value, what) => {
  log.debug('uuid check', { what, chars: value?.length });
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayError('invalid', what, `${what} expects an opaque UUID string`);
  }
};

const assertBytes = (bytes) => {
  log.debug('bytes check', { bytes: bytes?.length });
  if (!(bytes instanceof Uint8Array)) {
    throw new GatewayError('invalid', 'bleWrite', 'bleWrite expects Uint8Array bytes');
  }
};

/** The shared shape of the four GATT calls: opaque token + UUID tuple. */
const gattArgs = (connectionId, service, characteristic) => {
  log.debug('gatt tuple check', { chars: connectionId?.length, service, characteristic });
  assertToken(connectionId, 'connectionId');
  assertUuid(service, 'service');
  assertUuid(characteristic, 'characteristic');
};

/** The service calls — each mirrors its gateway primitive's signature
 * verbatim, adding only the typed validation above the raw shim. */
const serviceCalls = {
  scanStart: async (request = {}) => {
    log.debug('ble.scanStart', { filters: request?.serviceUuids?.length ?? 0 });
    if (request?.serviceUuids !== undefined
      && (!Array.isArray(request.serviceUuids)
        || request.serviceUuids.some((u) => typeof u !== 'string'))) {
      throw new GatewayError('invalid', 'bleScanStart', 'serviceUuids expects an array of UUID strings');
    }
    return await bleScanStart(request);
  },
  scanStop: async (scanId) => {
    assertToken(scanId, 'scanId');
    return await bleScanStop(scanId);
  },
  connect: async (deviceId) => {
    assertToken(deviceId, 'deviceId');
    return await bleConnect(deviceId);
  },
  disconnect: async (connectionId) => {
    assertToken(connectionId, 'connectionId');
    return await bleDisconnect(connectionId);
  },
  read: async (connectionId, service, characteristic) => {
    gattArgs(connectionId, service, characteristic);
    return await bleRead(connectionId, service, characteristic);
  },
  write: async (connectionId, service, characteristic, bytes, opts = {}) => {
    gattArgs(connectionId, service, characteristic);
    assertBytes(bytes);
    return await bleWrite(connectionId, service, characteristic, bytes, opts);
  },
  subscribe: async (connectionId, service, characteristic) => {
    gattArgs(connectionId, service, characteristic);
    return await bleSubscribe(connectionId, service, characteristic);
  },
  unsubscribe: async (connectionId, service, characteristic) => {
    gattArgs(connectionId, service, characteristic);
    return await bleUnsubscribe(connectionId, service, characteristic);
  },
};

/** Activation hook (manifest.hooks.activate): registers the `ble` service.
 * The event tap rides the shim's sanctioned subscription: only `ble.event`
 * channel records (device batches, GATT notifications, disconnects) are
 * forwarded to this service's subscribers. */
export function activate({ register }) {
  log.debug('activating dsh-ble');

  const listeners = new Set();

  /** Subscribe to `ble.event` records; returns the unsubscribe fn. */
  const subscribeEvents = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  onEvent((ev) => {
    if (ev?.event === 'ble.event') {
      listeners.forEach((fn) => fn(ev));
    }
  });

  register('ble', {
    ...serviceCalls,
    onEvent: subscribeEvents,
  });
}
