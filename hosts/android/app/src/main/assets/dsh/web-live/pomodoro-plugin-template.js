/**
 * pomodoro-plugin-template — the reference deliverable for the creation
 * turn "生成番茄时钟插件": a workspace-authored cordis plugin that
 * presents a NATIVE arc timer through the render surface (contract
 * v1.10.0). The scripted creation stream writes these bytes to
 * plugins/pomodoro-clock/plugin.js; the live-mount seam (plugin-mount.js)
 * registers them on the host loader and `ctx.plugin()`s the namespace —
 * real code, loaded at runtime, no HTML anywhere.
 *
 * The plugin's whole world is gateway primitives: surface.js for the
 * native surface (present/draw/close + the input channel), the timer seam
 * for the 1 Hz tick. On a host without the surface presentSurface answers
 * unavailable and the plugin refuses honestly (the negotiation floor —
 * the creation card viewer) — mounting never depends on the surface
 * existing.
 */
import {
  presentSurface, surfaceDraw, closeSurface, onSurfaceEvent,
} from 'surface.js';
import { timerSchedule, timerCancel, onEvent } from 'gateway.js';
import { createLogger } from 'logger.js';

const log = createLogger('plugin.pomodoro');

const FOCUS_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;

export const name = 'pomodoro-clock';
export const inject = [];

const mmss = (total) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;

/** One pomodoro's mutable state — the factories below close over it. */
const newState = () => ({
  surface: null, // {surfaceId, width, height}
  mode: 'focus', // focus | break
  remaining: FOCUS_SECONDS,
  running: false,
  timerId: null,
  zones: [], // [{x, y, w, h, action}] — this frame's hit zones
});

/** The arc-ring frame builder (pure: state → ops). */
const frameOps = (st) => {
  log.debug('frame build', { remaining: st.remaining, mode: st.mode });
  const { width, height } = st.surface;
  const cx = width / 2;
  const cy = height * 0.38;
  const r = Math.min(width, height) * 0.26;
  const total = st.mode === 'focus' ? FOCUS_SECONDS : BREAK_SECONDS;
  const start = -Math.PI / 2;
  const end = start + 2 * Math.PI * (st.remaining / total);
  const ring = st.mode === 'focus' ? '#34c759' : '#5e5ce6';
  const ops = [
    { op: 'clear', color: '#111114' },
    { op: 'setStyle', stroke: '#2c2c30', lineWidth: Math.max(8, r * 0.08) },
    { op: 'strokePath', d: [
      { c: 'move', x: cx + r, y: cy },
      { c: 'arc', x: cx, y: cy, r, start: 0, end: 2 * Math.PI },
    ] },
    { op: 'setStyle', stroke: ring, lineWidth: Math.max(8, r * 0.08) },
    { op: 'strokePath', d: [
      { c: 'move', x: cx + r * Math.cos(start), y: cy + r * Math.sin(start) },
      { c: 'arc', x: cx, y: cy, r, start, end },
    ] },
    { op: 'setStyle', fill: '#f4f4f6', font: `${Math.round(r * 0.5)}px sans-serif` },
    { op: 'text', x: cx, y: cy, text: mmss(st.remaining), baseline: 'middle' },
    { op: 'setStyle', fill: '#98989e', font: `${Math.round(r * 0.16)}px sans-serif` },
    { op: 'text', x: cx, y: cy + r * 0.42, text: st.mode === 'focus' ? '专注' : '休息', baseline: 'middle' },
  ];
  const buttonW = Math.min(width * 0.36, 220);
  const buttonH = Math.max(44, height * 0.06);
  const buttonY = height * 0.66;
  const gap = width * 0.06;
  const button = (bx, label, action) => {
    st.zones.push({ x: bx, y: buttonY, w: buttonW, h: buttonH, action });
    ops.push({ op: 'setStyle', fill: '#2c2c30' });
    ops.push({ op: 'fillRect', x: bx, y: buttonY, w: buttonW, h: buttonH });
    ops.push({ op: 'setStyle', fill: '#f4f4f6', font: `${Math.round(buttonH * 0.42)}px sans-serif` });
    ops.push({ op: 'text', x: bx + buttonW / 2, y: buttonY + buttonH / 2, text: label, baseline: 'middle' });
  };
  button((width - buttonW * 2 - gap) / 2, st.running ? '暂停' : '开始', 'toggle');
  button((width + gap) / 2, '重置', 'reset');
  return ops;
};

/** draw: submit one atomic frame; a closed surface stops the clock. */
const makeDraw = (st) => async () => {
  log.debug('draw', { running: st.running });
  if (st.surface === null) return;
  try {
    await surfaceDraw(st.surface.surfaceId, frameOps(st),
      { seq: st.remaining + (st.running ? 0.5 : 0) });
  } catch {
    st.running = false; // the surface closed under us (user dismissal)
  }
};

/** armTick: one timer at a time while running (D8 — event-driven, no
 * polling loop). */
const makeArmTick = (st) => async () => {
  log.debug('arm tick', { running: st.running });
  if (st.timerId !== null) {
    await timerCancel(st.timerId).catch(() => {});
    st.timerId = null;
  }
  if (!st.running) return;
  const { timerId: id } = await timerSchedule(1000, { tag: 'pomodoro' });
  st.timerId = id;
};

/** One live pomodoro on one context: the tick + touch listeners, the
 * surface open, and the dispose hook (all state local to apply). */
/** The 1 Hz tick listener: one armed timer, one fire, redraw + re-arm. */
const makeTickListener = (st, draw, armTick) => onEvent(async (ev) => {
  log.debug('tick fire', { timerId: ev?.timerId ?? null });
  if (ev?.event !== 'timer.fire') return;
  if (st.timerId === null || ev.timerId !== st.timerId) return;
  st.timerId = null;
  if (!st.running) return;
  st.remaining -= 1;
  if (st.remaining <= 0) {
    st.mode = st.mode === 'focus' ? 'break' : 'focus';
    st.remaining = st.mode === 'focus' ? FOCUS_SECONDS : BREAK_SECONDS;
  }
  await draw();
  await armTick();
});

/** The touch listener: hit-test this frame's zones, toggle/reset. */
const makeInputListener = (st, draw, armTick) => onSurfaceEvent(async (ev) => {
  log.debug('input', { kind: ev?.kind ?? null });
  if (st.surface === null || ev.surfaceId !== st.surface.surfaceId) return;
  if (ev.kind !== 'begin' || typeof ev.x !== 'number' || typeof ev.y !== 'number') return;
  const hit = st.zones.find((z) => ev.x >= z.x && ev.x <= z.x + z.w
    && ev.y >= z.y && ev.y <= z.y + z.h);
  if (hit === undefined) return;
  if (hit.action === 'toggle') st.running = !st.running;
  if (hit.action === 'reset') {
    st.mode = 'focus';
    st.remaining = FOCUS_SECONDS;
    st.running = false;
  }
  await draw();
  await armTick();
});

export const apply = (ctx) => {
  log.debug('apply', {});
  const st = newState();
  const draw = makeDraw(st);
  const armTick = makeArmTick(st);
  const offTick = makeTickListener(st, draw, armTick);
  const offEvents = makeInputListener(st, draw, armTick);

  if (ctx && typeof ctx.on === 'function') {
    ctx.on('dispose', async () => {
      log.debug('dispose', {});
      offEvents();
      offTick();
      st.running = false;
      await armTick(); // disarms: !running
      if (st.surface !== null) await closeSurface(st.surface.surfaceId).catch(() => {});
      st.surface = null;
    });
  }

  // Fire-and-soft open: on a host without the render surface the plugin
  // logs the refusal — mounting already succeeded, the creation card is
  // the floor.
  (async () => {
    try {
      const opened = await presentSurface({ kind: 'canvas2d', title: '番茄时钟' });
      if (opened === null || opened === undefined) {
        log.warn('no native surface on this host', {});
        return;
      }
      st.surface = opened;
      await draw();
      log.info('pomodoro surface open', {
        surfaceId: opened.surfaceId, width: opened.width, height: opened.height });
    } catch (error) {
      log.warn('pomodoro surface refused', { reason: error?.message ?? String(error) });
    }
  })();
};

export default apply;
