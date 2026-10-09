/**
 * surface — the render-surface face of the capability gateway (contract
 * v1.10.0, folded 2026-10-08): presentSurface / surfaceDraw / closeSurface
 * over the same `call` seam gateway.js owns every other primitive. Split
 * from gateway.js at the code-size gate (the file crossed 500 lines when
 * this face landed).
 *
 * Ops are the closed `surface.ops@1` vocabulary (data-protocols.md §9);
 * `opts.animate: true` arms the host's frame pump (surface.frame events
 * arrive on gateway.js's onEvent seam); the user dismissing the surface
 * resolves presentSurface null and the next surfaceDraw settles invalid
 * (the contract's fail-soft posture).
 */
import { createLogger } from 'logger.js';
import { call, onEvent } from 'gateway.js';

const log = createLogger('dsh.surface');

/** Open one host-native fullscreen drawing surface (single-surface v0:
 * a second open while one is live resolves null — fail-soft, never queue). */
export const presentSurface = async (request) => {
  log.debug('presentSurface', { kind: request?.kind ?? null });
  return await call('presentSurface', request);
};

/** Submit one atomic frame; a malformed op fails the whole call and the
 * previous frame stays (double-buffered). */
export const surfaceDraw = async (surfaceId, ops, opts = {}) => {
  log.debug('surfaceDraw', { surfaceId, ops: ops.length, seq: opts.seq ?? null });
  return await call('surfaceDraw', { surfaceId, ops, ...opts });
};

/** End the surface (idempotent — unknown or closed resolves normally). */
export const closeSurface = async (surfaceId) => {
  log.debug('closeSurface', { surfaceId });
  await call('closeSurface', { surfaceId });
};

/** The surface channels ride the gateway event seam (§5): surface.frame
 * (armed by animate) and surface.input (touch/key on an open surface). */
export const onSurfaceEvent = (fn) => onEvent((ev) => {
  if (ev?.event !== 'surface.frame' && ev?.event !== 'surface.input') return;
  fn(ev);
});
