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
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayError('invalid', what, `${what} expects an opaque UUID string`);
  }
};

const assertBytes = (bytes) => {
  if (!(bytes instanceof Uint8Array)) {
    throw new GatewayError('invalid', 'bleWrite', 'bleWrite expects Uint8Array bytes');
  }
};

/** Activation hook (manifest.hooks.activate): registers the `ble` service.
 * Every call mirrors its gateway primitive's signature verbatim; the event
 * tap hands `ble.event` channel records (device batches, GATT notifications,
 * disconnects) to subscribers registered through onEvent. */
export function activate({ register }) {
  log.debug('activating dsh-ble');

  const listeners = new Set();

  /** The shim's sanctioned bridge-event subscription; only `ble.event`
   * records are forwarded to this service's subscribers. */
  onEvent((ev) => {
    if (ev?.event === 'ble.event') {
      listeners.forEach((fn) => fn(ev));
    }
  });

  /** Subscribe to `ble.event` channel records; returns the unsubscribe fn. */
  const subscribeEvents = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  const scanStart = async (request = {}) => {
    log.debug('ble.scanStart', { filters: request?.serviceUuids?.length ?? 0 });
    if (request?.serviceUuids !== undefined
      && (!Array.isArray(request.serviceUuids)
        || request.serviceUuids.some((u) => typeof u !== 'string'))) {
      throw new GatewayError('invalid', 'bleScanStart', 'serviceUuids expects an array of UUID strings');
    }
    return await bleScanStart(request);
  };

  const scanStop = async (scanId) => {
    assertToken(scanId, 'scanId');
    return await bleScanStop(scanId);
  };

  const connect = async (deviceId) => {
    assertToken(deviceId, 'deviceId');
    return await bleConnect(deviceId);
  };

  const disconnect = async (connectionId) => {
    assertToken(connectionId, 'connectionId');
    return await bleDisconnect(connectionId);
  };

  const read = async (connectionId, service, characteristic) => {
    assertToken(connectionId, 'connectionId');
    assertUuid(service, 'service');
    assertUuid(characteristic, 'characteristic');
    return await bleRead(connectionId, service, characteristic);
  };

  const write = async (connectionId, service, characteristic, bytes, opts = {}) => {
    assertToken(connectionId, 'connectionId');
    assertUuid(service, 'service');
    assertUuid(characteristic, 'characteristic');
    assertBytes(bytes);
    return await bleWrite(connectionId, service, characteristic, bytes, opts);
  };

  const subscribe = async (connectionId, service, characteristic) => {
    assertToken(connectionId, 'connectionId');
    assertUuid(service, 'service');
    assertUuid(characteristic, 'characteristic');
    return await bleSubscribe(connectionId, service, characteristic);
  };

  const unsubscribe = async (connectionId, service, characteristic) => {
    assertToken(connectionId, 'connectionId');
    assertUuid(service, 'service');
    assertUuid(characteristic, 'characteristic');
    return await bleUnsubscribe(connectionId, service, characteristic);
  };

  register('ble', {
    scanStart,
    scanStop,
    connect,
    disconnect,
    read,
    write,
    subscribe,
    unsubscribe,
    onEvent: subscribeEvents,
  });
}
