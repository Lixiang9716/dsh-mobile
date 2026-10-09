/**
 * Scenario `card.player` — PR-1 of the create-approve-hotmount-native
 * loop: a plugin's card speaks bus lines (`card.present` / `card.state` /
 * `card.complete`) and the host's NATIVE CardPlayerSurface renders them in
 * the app's own chrome — the plugin manifests in the app, NOT as an HTML
 * page (the owner's explicit product bar).
 *
 * The ticks deliberately ride the gateway timer seam (contract v1.4.0 §5):
 * one-shot `timerSchedule` arms in a re-arm loop — NO setInterval (the
 * contract is one-shot by design) — so this leg doubles as the iOS timer
 * primitive's first functional proof: a denied arm would fail the run loud
 * (the shim's arm/failed warn), and a fire that never lands would hang the
 * loop and miss the deadline.
 */
import { createLogger } from '../logger.js';
import { scenarioModule } from '../transport-tokens.mjs';
import 'upstream/shims/timers.js';

const SCENARIO = 'card.player';
const log = createLogger(scenarioModule);
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const post = (msg) => globalThis.__dshBusPost?.(JSON.stringify(msg));
const fail = (reason) => {
  log.debug('scenario failed', { reason });
  emit('scenario.failed', { reason });
  globalThis.__dshComplete(false, reason);
};

const FOCUS_MS = 25 * 60 * 1000;
const TICKS = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

emit('card.player.begin', {});
if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('card.seat.ready', { gateway: 'gateway@1' });

  post({
    type: 'card.present',
    card: {
      id: 'pomodoro-demo', kind: 'timer', title: '番茄时钟 · 专注',
      subtitle: '25 分钟专注回合', durationMs: FOCUS_MS,
    },
  });
  emit('card.present.posted', { id: 'pomodoro-demo', durationMs: FOCUS_MS });

  for (let tick = 1; tick <= TICKS; tick++) {
    await sleep(1000); // the re-arm loop: one-shot arms, §5 fires resolve
    const remainingMs = FOCUS_MS - tick * 1000;
    post({
      type: 'card.state', id: 'pomodoro-demo',
      state: { remainingMs, label: `专注中 · 剩 ${Math.ceil(remainingMs / 1000)} 秒` },
    });
    emit('card.state.posted', { tick, remainingMs });
  }

  await sleep(800);
  post({ type: 'card.complete', id: 'pomodoro-demo', message: '本回合完成 · 休息 5 分钟' });
  emit('card.complete.posted', { id: 'pomodoro-demo' });
  emit('card.player.done', { ticks: TICKS });
  emit('scenario.complete', { status: 'pass' });
  globalThis.__dshComplete(true, 'card.player settled');
}
