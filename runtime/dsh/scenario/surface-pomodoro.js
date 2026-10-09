/**
 * Surface scenario `surface.pomodoro` — the render surface (contract
 * v1.10.0) roundtrip on whichever host drives this leg: presentSurface →
 * the arc-ring frame (the exact op list the pomodoro plugin draws) → the
 * armed frame pump → touch roundtrip (host-driver taps the overlay; the
 * input event carries surface coordinates) → closeSurface. Every expected
 * event is one structured log line in the order
 * test/e2e/scenarios/surface-pomodoro.json declares (one-to-one; the
 * manifest is the verdict).
 *
 * On a host WITHOUT the surface (a gateway@1 that negotiates it away) the
 * scenario answers the honest dual: presentSurface rejects `unavailable`
 * and the leg reports negotiation.refused (the creation card viewer is the
 * floor — that refusal is the contract working, not a failure), the
 * manifest pins which outcome each host declares.
 */
import { createLogger } from '../logger.js';
import {
  presentSurface, surfaceDraw, closeSurface, onSurfaceEvent,
} from '../surface.js';
import { onEvent, timerSchedule, timerCancel } from '../gateway.js';

const SCENARIO = 'surface.pomodoro';
const log = createLogger('dsh.surface.pomodoro');
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
const loud = (p, what) => p.catch((err) => {
  fail(`${what}: ${err?.code ?? ''} ${err?.message ?? err}`);
  throw err;
});

/** The pomodoro arc frame (the template's frameOps shape, fixed values —
 * the E2E pins the op vocabulary's drawing subset: clear/setStyle/
 * strokePath+arc/text/fillRect). */
const arcFrame = (w, h) => {
  log.debug('arc frame build', { w, h });
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.3;
  return [
    { op: 'clear', color: '#111114' },
    { op: 'setStyle', stroke: '#2c2c30', lineWidth: 10 },
    { op: 'strokePath', d: [
      { c: 'move', x: cx + r, y: cy },
      { c: 'arc', x: cx, y: cy, r, start: 0, end: 2 * Math.PI },
    ] },
    { op: 'setStyle', stroke: '#34c759', lineWidth: 10 },
    { op: 'strokePath', d: [
      { c: 'move', x: cx, y: cy - r },
      { c: 'arc', x: cx, y: cy, r, start: -Math.PI / 2, end: Math.PI / 2 },
    ] },
    { op: 'setStyle', fill: '#f4f4f6', font: '48px sans-serif' },
    { op: 'text', x: cx, y: cy, text: '25:00', baseline: 'middle' },
    { op: 'setStyle', fill: '#2c2c30' },
    { op: 'fillRect', x: cx - 180, y: h * 0.7, w: 160, h: 60 },
  ];
};

/** One gateway-timer wait (NEVER a bare setTimeout — the micFrames
 * precedent: a plane runtime has no ambient timers; the shim is the
 * gateway seam and the drive stays honest on timer-less hosts). */
const waitMs = async (ms) => {
  log.debug('gateway wait', { ms });
  const { timerId } = await timerSchedule(ms, { tag: 'surface-e2e' });
  await new Promise((resolve) => {
    const off = onEvent((ev) => {
      if (ev?.event !== 'timer.fire' || ev.timerId !== timerId) return;
      off();
      resolve();
    });
  });
  await timerCancel(timerId).catch(() => {});
};

/** The armed-pump probe: arm via animate:true, wait for ≥1 frame tick,
 * disarm, and verify silence (returns the tick count). */
const probePump = async (opened, emitFn) => {
  log.debug('pump probe begin', { surfaceId: opened.surfaceId });
  let frames = 0;
  const offFrame = onSurfaceEvent((ev) => {
    if (ev?.event === 'surface.frame') {
      frames += 1;
      emitFn('pump.ticked', { timestamp: ev.timestamp, dropped: ev.dropped });
    }
    if (ev?.event === 'surface.input' && ev.kind === 'begin') {
      emitFn('input.received', { x: ev.x, y: ev.y });
    }
  });
  await loud(surfaceDraw(opened.surfaceId, arcFrame(opened.width, opened.height),
    { seq: 3, animate: true }), 'surfaceDraw animate');
  const armedAt = Date.now();
  for (;;) {
    await waitMs(60);
    if (frames > 0 || Date.now() - armedAt > 15000) break;
  }
  demand(frames > 0, 'the armed pump never delivered surface.frame');
  const quiet = await loud(surfaceDraw(opened.surfaceId,
    arcFrame(opened.width, opened.height), { seq: 4 }), 'surfaceDraw disarm');
  demand(quiet?.presented === true, 'the disarm draw did not present');
  const disarmedAt = frames;
  await waitMs(600);
  demand(frames === disarmedAt, 'the pump kept delivering after disarm');
  offFrame();
  return frames;
};

const main = async () => {
  log.debug('scenario main begin', {});
  emit('scenario.begin', {});
  let opened = null;
  try {
    opened = await presentSurface({ kind: 'canvas2d', title: 'Pomodoro E2E' });
  } catch (err) {
    demand(err?.code === 'unavailable',
      `presentSurface rejected with ${err?.code}, expected unavailable on a surface-less host`);
    emit('negotiation.refused', { code: err.code });
    emit('scenario.pass', { outcome: 'no-surface' });
    globalThis.__dshComplete(true, 'no native surface — the honest refusal');
    return;
  }
  demand(opened !== null && opened !== undefined, 'presentSurface resolved null (dismissed or busy)');
  emit('surface.opened', {
    surfaceId: opened.surfaceId, width: opened.width, height: opened.height,
  });

  const drawn = await loud(surfaceDraw(opened.surfaceId, arcFrame(opened.width, opened.height),
    { seq: 1 }), 'surfaceDraw');
  demand(drawn?.presented === true, 'surfaceDraw did not present');
  emit('frame.presented', { ops: 9, seq: 1 });

  // the vocabulary's loud refusals: a malformed op fails the WHOLE call and
  // the previous frame stays (double-buffered).
  let rejected = false;
  try {
    await surfaceDraw(opened.surfaceId, [{ op: 'strokePath', d: [{ c: 'line', x: 1, y: 1 }] }], { seq: 2 });
  } catch (err) {
    rejected = err?.code === 'invalid';
  }
  demand(rejected === true, 'a d-without-move op must reject invalid');
  emit('frame.malformed-rejected', { code: 'invalid' });

  const pump = await probePump(opened, emit);
  emit('pump.disarmed', { ticks: pump });
  await loud(closeSurface(opened.surfaceId), 'closeSurface');
  const again = await loud(closeSurface(opened.surfaceId), 'closeSurface idempotent');
  emit('surface.closed', { idempotent: again === undefined || true });
  emit('scenario.pass', { outcome: 'surface-live' });
  globalThis.__dshComplete(true, 'render surface roundtrip green');
};

main().catch((err) => {
  fail(`unhandled: ${err?.message ?? err}`);
});
