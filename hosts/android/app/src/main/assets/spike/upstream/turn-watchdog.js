/**
 * upstream/turn-watchdog.js — the turn-level watchdog (issue #323, ring 2).
 *
 * The per-tool deadline (upstream/tool-deadline.js) bounds tool dispatch;
 * a turn can still wedge OUTSIDE it — an LLM stream that stalls mid-frame,
 * a loop-internal await that never settles. This watchdog arms a re-armable
 * timer that every observable turn progress feeds (session journal appends,
 * assistant-stream frames, agent status transitions); when a full budget
 * passes with NO progress while an agent is running, it fails the turn
 * IN-BAND: the running agent(s) are cancelled with a `watchdog` cause
 * (keepInbox — queued user messages are not the wedge), the loop unwinds at
 * its next await boundary, and the journal records the abort honestly.
 *
 * Honest limit, same as ring 1: the timer rides the runtime's own timer seam
 * (the setTimeout shim → gateway timerSchedule), so a thread pinned by a
 * synchronous spin cannot fire it — that class belongs to the spinning layer
 * (see the #323 note's wasm3 paragraph). This ring converts every
 * event-loop-alive stall into an in-banded failed turn instead of a silent
 * wedge.
 */
import { createLogger } from 'logger.js';

const log = createLogger('dsh.turn-watchdog');

/** The default silence budget. Tool dispatch is already bounded at 120s per
 * call (ring 1); the outer ring only trips when the WHOLE spine went quiet —
 * 5 minutes of zero journal/stream/status activity on a running agent. */
export const DEFAULT_BUDGET_MS = 300_000;

/** The progress events a live turn emits (dsh-session's append dispatch,
 * dsh-agent-loop's stream/status emissions). Any one re-arms the timer. */
const PROGRESS_EVENTS = [
  'session/event',
  'agent/assistant-stream',
  'agent/status',
];

/** Validate the configured budget (rule 5). */
export const parseBudgetMs = (value) => {
  log.debug('budget parse', { value });
  if (value === undefined) return DEFAULT_BUDGET_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `turn-watchdog: budgetMs must be a positive finite number, got ${JSON.stringify(value)}`);
  }
  return value;
};

/** The re-armable watchdog. `listRunning` answers candidate agents (the
 * registry's list); the watchdog itself narrows to `status === 'running'`,
 * so a caller handing it a superset cannot arm cancellations against idle
 * agents. `onCancel` is the caller's observation hook (tests). */
export const makeTurnWatchdog = ({ budgetMs, listRunning, onCancel } = {}) => {
  if (typeof listRunning !== 'function') {
    throw new Error('turn-watchdog: listRunning(answer candidate agents) is required');
  }
  const running = () => listRunning().filter((agent) => agent?.status === 'running');
  let timer = null;
  const fire = () => {
    timer = null;
    const runningNow = running();
    if (runningNow.length === 0) return; // nothing wedged; stay disarmed
    const agents = runningNow.map((agent) => agent?.id ?? '(unknown)');
    log.warn('turn watchdog fired', { budgetMs, agents });
    for (const agent of runningNow) {
      try {
        agent.cancel(
          { kind: 'watchdog', message: `no turn progress for ${budgetMs}ms` },
          { keepInbox: true },
        );
        onCancel?.(agent);
      } catch (error) {
        // fail loud in the log, never rethrow into the timer seam — the
        // other running agents still get their cancel
        log.warn('watchdog cancel failed', {
          agent: agent?.id ?? '(unknown)',
          reason: `${error?.message ?? error}`,
        });
      }
    }
  };
  return {
    /** Feed one observable progress: re-arm only while something runs. */
    markProgress() {
      if (running().length === 0) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fire, budgetMs);
    },
    isArmed: () => timer !== null,
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
};

export const name = 'turn-watchdog';

/** After `agentLoop` — the loop whose turns it watches; the agents registry
 * it reads is mounted before the loop (boot order). */
export const inject = ['agentLoop', 'agents'];

export const apply = (ctx, config) => {
  const budgetMs = parseBudgetMs(config?.budgetMs);
  const registry = ctx.get('agents');
  if (registry === undefined || typeof registry.list !== 'function') {
    throw new Error('turn-watchdog: the agents registry (ctx.agents.list) is not mounted');
  }
  const watchdog = makeTurnWatchdog({
    budgetMs,
    listRunning: () => registry.list(),
  });
  for (const event of PROGRESS_EVENTS) {
    // the disposers ride the plugin fiber (cordis tracks them); the timer
    // self-neutralizes after teardown because listRunning() empties
    ctx.on(event, () => watchdog.markProgress());
  }
  log.info('turn watchdog mounted', { budgetMs, progress: PROGRESS_EVENTS });
};
