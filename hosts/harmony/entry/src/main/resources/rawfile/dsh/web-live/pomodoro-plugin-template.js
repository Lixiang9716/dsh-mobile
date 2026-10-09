/**
 * pomodoro-plugin-template — the reference deliverable for the creation
 * turn "生成番茄时钟插件": a workspace-authored cordis plugin that
 * presents a NATIVE arc timer through the render surface (contract
 * v1.10.0). The scripted creation stream writes these bytes to
 * plugins/pomodoro-clock/plugin.js; the live-mount seam (plugin-mount.js)
 * registers them on the host loader and `ctx.plugin()`s the namespace —
 * real code, loaded at runtime, no HTML anywhere.
 *
 * The plugin's whole world is gateway primitives: presentSurface/
 * surfaceDraw/closeSurface for the native surface, timerSchedule for the
 * 1 Hz tick (the timer.fire event channel), onEvent for tick + touch.
 * On a host without the surface the present answers unavailable and the
 * plugin refuses honestly (the negotiation floor — the creation card
 * viewer) — mounting never depends on the surface existing.
 */
import {
  presentSurface, surfaceDraw, closeSurface, timerSchedule, timerCancel, onEvent,
} from 'gateway.js';
import { createLogger } from 'logger.js';

const log = createLogger('plugin.pomodoro');

const FOCUS_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;

export const name = 'pomodoro-clock';
export const inject = [];

/** One live pomodoro on one context. All state is local to apply; the
 * dispose hook closes the surface and disarms the tick (D8: event-driven,
 * no polling loops — the tick arms one timer at a time). */
export const apply = (ctx) => {
  let surface = null; // {surfaceId, width, height}
  let mode = 'focus'; // focus | break
  let remaining = FOCUS_SECONDS;
  let running = false;
  let timerId = null;
  let zones = []; // [{x, y, w, h, action}]
  let offEvents = () => {};
  let offTick = () => {};

  const mmss = (total) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;

  const draw = async () => {
    if (surface === null) return;
    const { surfaceId, width, height } = surface;
    const cx = width / 2;
    const cy = height * 0.38;
    const r = Math.min(width, height) * 0.26;
    const total = mode === 'focus' ? FOCUS_SECONDS : BREAK_SECONDS;
    const progress = remaining / total;
    const start = -Math.PI / 2;
    const end = start + 2 * Math.PI * progress;
    const ring = mode === 'focus' ? '#34c759' : '#5e5ce6';
    zones = [];
    const ops = [
      { op: 'clear', color: '#111114' },
      { op: 'setStyle', stroke: '#2c2c30', lineWidth: Math.max(8, r * 0.08) },
      { op: 'strokePath', d: [
        { c: 'move', x: cx + r, y: cy },
        { c: 'arc', x: cx, y: cy, r, start: 0, end: 2 * Math.PI },
      ] },
      { op: 'setStyle', stroke: ring, lineWidth: Math.max(8, r * 0.08) },
      { op: 'strokePath', d: progress > 0 ? [
        { c: 'move', x: cx + r * Math.cos(start), y: cy + r * Math.sin(start) },
        { c: 'arc', x: cx, y: cy, r, start, end },
      ] : [{ c: 'move', x: cx + r, y: cy }] },
      { op: 'setStyle', fill: '#f4f4f6', font: `${Math.round(r * 0.5)}px sans-serif` },
      { op: 'text', x: cx, y: cy, text: mmss(remaining), baseline: 'middle' },
      { op: 'setStyle', fill: '#98989e', font: `${Math.round(r * 0.16)}px sans-serif` },
      { op: 'text', x: cx, y: cy + r * 0.42, text: mode === 'focus' ? '专注' : '休息', baseline: 'middle' },
    ];
    const buttonW = Math.min(width * 0.36, 220);
    const buttonH = Math.max(44, height * 0.06);
    const buttonY = height * 0.66;
    const drawButton = (bx, label, action) => {
      zones.push({ x: bx, y: buttonY, w: buttonW, h: buttonH, action });
      ops.push({ op: 'setStyle', fill: '#2c2c30' });
      ops.push({ op: 'fillRect', x: bx, y: buttonY, w: buttonW, h: buttonH });
      ops.push({ op: 'setStyle', fill: '#f4f4f6', font: `${Math.round(buttonH * 0.42)}px sans-serif` });
      ops.push({ op: 'text', x: bx + buttonW / 2, y: buttonY + buttonH / 2, text: label, baseline: 'middle' });
    };
    const gap = width * 0.06;
    drawButton((width - buttonW * 2 - gap) / 2, running ? '暂停' : '开始', 'toggle');
    drawButton((width + gap) / 2, '重置', 'reset');
    try {
      await surfaceDraw(surfaceId, ops, { seq: remaining + (running ? 0.5 : 0) });
    } catch {
      // the surface closed under us (user dismissal): stop the tick.
      running = false;
    }
  };

  const armTick = async () => {
    if (timerId !== null) {
      await timerCancel(timerId).catch(() => {});
      timerId = null;
    }
    if (!running) return;
    const { timerId: id } = await timerSchedule(1000, { tag: 'pomodoro' });
    timerId = id;
  };

  offTick = onEvent(async (ev) => {
    if (ev?.event !== 'timer.fire') return;
    if (timerId === null || ev.timerId !== timerId) return;
    timerId = null;
    if (!running) return;
    remaining -= 1;
    if (remaining <= 0) {
      mode = mode === 'focus' ? 'break' : 'focus';
      remaining = mode === 'focus' ? FOCUS_SECONDS : BREAK_SECONDS;
    }
    await draw();
    await armTick();
  });

  offEvents = onEvent(async (ev) => {
    if (ev?.event !== 'surface.input' || surface === null) return;
    if (ev.surfaceId !== surface.surfaceId) return;
    if (ev.kind !== 'begin' || typeof ev.x !== 'number' || typeof ev.y !== 'number') return;
    const hit = zones.find((z) => ev.x >= z.x && ev.x <= z.x + z.w && ev.y >= z.y && ev.y <= z.y + z.h);
    if (hit === undefined) return;
    if (hit.action === 'toggle') running = !running;
    if (hit.action === 'reset') { mode = 'focus'; remaining = FOCUS_SECONDS; running = false; }
    await draw();
    await armTick();
  });

  if (ctx && typeof ctx.on === 'function') {
    ctx.on('dispose', async () => {
      offEvents();
      offTick();
      running = false;
      await armTick(); // disarms: !running
      if (surface !== null) await closeSurface(surface.surfaceId).catch(() => {});
      surface = null;
    });
  }

  // The surface open is fire-and-soft: on a host without the render
  // surface presentSurface answers unavailable and the plugin logs the
  // refusal — mounting (the caller's goal) already succeeded by then, and
  // the creation card remains the floor.
  (async () => {
    try {
      const opened = await presentSurface({ kind: 'canvas2d', title: '番茄时钟' });
      if (opened === null || opened === undefined) {
        log.warn('no native surface on this host', {});
        return;
      }
      surface = opened;
      await draw();
      log.info('pomodoro surface open', {
        surfaceId: opened.surfaceId, width: opened.width, height: opened.height });
    } catch (error) {
      log.warn('pomodoro surface refused', { reason: error?.message ?? String(error) });
    }
  })();
};

export default apply;
