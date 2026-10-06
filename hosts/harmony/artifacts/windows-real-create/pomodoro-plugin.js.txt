/**
 * pomodoro-clock/plugin.js
 * 番茄时钟插件：25 分钟专注 + 5 分钟休息循环计时。
 *
 * 导出：
 *   start()          - 开始（或暂停后恢复）计时
 *   reset()          - 停止计时并重置到初始专注阶段
 *   remainingSeconds - getter，返回当前阶段剩余秒数（整数）
 */
'use strict';

const FOCUS_SECONDS = 25 * 60; // 25 分钟专注
const BREAK_SECONDS = 5 * 60;  // 5 分钟休息

const PHASE_FOCUS = 'focus';
const PHASE_BREAK = 'break';

let phase = PHASE_FOCUS;       // 当前阶段：focus | break
let remaining = FOCUS_SECONDS; // 当前阶段剩余秒数
let running = false;           // 是否正在计时
let timerId = null;            // setInterval 句柄

function durationOf(currentPhase) {
  return currentPhase === PHASE_FOCUS ? FOCUS_SECONDS : BREAK_SECONDS;
}

function enterNextPhase() {
  phase = phase === PHASE_FOCUS ? PHASE_BREAK : PHASE_FOCUS;
  remaining = durationOf(phase);
}

function tick() {
  remaining -= 1;
  if (remaining <= 0) {
    enterNextPhase();
  }
}

/** 开始（或恢复）计时 */
function start() {
  if (running) return;
  running = true;
  timerId = setInterval(tick, 1000);
}

/** 停止计时并重置到初始状态（专注阶段、满 25 分钟） */
function reset() {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
  running = false;
  phase = PHASE_FOCUS;
  remaining = FOCUS_SECONDS;
}

module.exports = {
  start,
  reset,
  get remainingSeconds() {
    return Math.max(0, Math.ceil(remaining));
  },
  // 附加的只读状态，便于宿主展示当前阶段（不属于必需接口）
  get phase() {
    return phase;
  },
  get running() {
    return running;
  },
};
