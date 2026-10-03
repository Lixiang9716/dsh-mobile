import { describe, it, expect } from 'vitest';
import {
  makeTurnWatchdog, parseBudgetMs, DEFAULT_BUDGET_MS,
} from '../../runtime/spike/upstream/turn-watchdog.js';

const runningAgent = (id) => ({
  id,
  status: 'running',
  calls: [],
  cancel(cause, options) { this.calls.push({ cause, options }); },
});

/** A fake registry whose `list()` answers `agents` by reference. */
const fakeRegistry = (agents) => ({
  list: () => [...agents],
});

/** One watchdog aimed at `agent`, with cancels recorded on the agent and in
 * `cancelled`. */
const watchdogFor = (agent, budgetMs, cancelled) => makeTurnWatchdog({
  budgetMs,
  listRunning: fakeRegistry([agent]).list,
  onCancel: (a) => cancelled.push(a),
});

describe('turn watchdog: silence fails the turn in-band', () => {
  it('a silent running turn is cancelled within the budget, never wedged', async () => {
    const agent = runningAgent('agent-1');
    const cancelled = [];
    const watchdog = watchdogFor(agent, 100, cancelled);
    watchdog.markProgress(); // the turn starts; the timer arms
    expect(watchdog.isArmed()).toBe(true);
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 400));
    watchdog.dispose();
    expect(cancelled).toEqual([agent]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(watchdog.isArmed()).toBe(false); // one-shot: it fired and disarmed
  });

  it('the cancel carries the watchdog cause and keeps the inbox', async () => {
    const agent = runningAgent('agent-1b');
    const watchdog = watchdogFor(agent, 80, []);
    watchdog.markProgress();
    await new Promise((resolve) => setTimeout(resolve, 300));
    watchdog.dispose();
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0].cause.kind).toBe('watchdog');
    expect(agent.calls[0].cause.message).toContain('no turn progress for 80ms');
    expect(agent.calls[0].options).toEqual({ keepInbox: true });
  });
});

describe('turn watchdog: progress re-arms, idleness never arms', () => {
  it('a turn that keeps making progress is never cancelled', async () => {
    const agent = runningAgent('agent-2');
    const cancelled = [];
    const watchdog = watchdogFor(agent, 120, cancelled);
    // progress every 40ms for ~600ms — 3x the silence budget in total, but
    // never one silent 120ms window
    for (let i = 0; i < 15; i += 1) {
      watchdog.markProgress();
      expect(watchdog.isArmed()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(cancelled).toEqual([]);
    expect(agent.calls).toHaveLength(0);
    watchdog.dispose();
    expect(watchdog.isArmed()).toBe(false);
  });

  it('stays disarmed when no agent is running', async () => {
    const idle = { id: 'agent-3', status: 'idle', calls: [] };
    idle.cancel = (cause, options) => { idle.calls.push({ cause, options }); };
    const cancelled = [];
    const watchdog = watchdogFor(idle, 80, cancelled);
    watchdog.markProgress(); // progress with nothing running: no arm
    expect(watchdog.isArmed()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cancelled).toEqual([]);
    expect(idle.calls).toHaveLength(0);
  });
});

describe('turn watchdog: construction contract', () => {
  it('validates the budget fail-loud and defaults sanely (rule 5)', () => {
    expect(DEFAULT_BUDGET_MS).toBe(300_000);
    expect(parseBudgetMs(undefined)).toBe(DEFAULT_BUDGET_MS);
    expect(parseBudgetMs(250)).toBe(250);
    for (const bad of [0, -5, NaN, Infinity, '300000', null]) {
      expect(() => parseBudgetMs(bad)).toThrow('budgetMs must be a positive finite number');
    }
  });

  it('demands a listRunning accessor', () => {
    expect(() => makeTurnWatchdog({ budgetMs: 100 })).toThrow('listRunning');
  });
});
