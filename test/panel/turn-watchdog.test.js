import { describe, it, expect } from 'vitest';
import {
  makeTurnWatchdog, parseBudgetMs, DEFAULT_BUDGET_MS,
  isSemanticStreamFrame, apply,
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

// ---- the #346 leg: wire liveness is not turn progress --------------------
// The stall: a real-model turn sat in "Deep diving…" >15 min because the
// think phase's reasoning frames kept re-arming the old any-frame watchdog.
// The stream event vocabulary below mirrors the vendored shapes (dsh-agent's
// fused dispatch payload `{ agent, frame }`; frame `{ type: 'start' |
// 'chunk' | 'end', chunk? }`; StreamChunk per dsh-llm types.ts).

const agentRef = { id: 'agent-1' };
const startFrame = () => ({ agent: agentRef, frame: { type: 'start' } });
const chunkFrame = (chunk) => ({
  agent: agentRef,
  frame: { type: 'chunk', index: 0, time: Date.now(), chunk },
});
const reasoningDelta = () => chunkFrame({ type: 'reasoning-delta', index: 0, text: 'thinking…' });
const textDelta = () => chunkFrame({ type: 'text-delta', index: 1, text: 'answer' });
const toolCallDelta = () => chunkFrame({ type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: '{"x"' });
const endFrame = () => ({ agent: agentRef, frame: { type: 'end', index: 0, outcome: { kind: 'abandoned' } } });

describe('turn watchdog: the assistant-stream feed is semantic-only (#346)', () => {
  it('counts answer text and tool calls, never reasoning, markers, or accounting', () => {
    for (const semantic of [textDelta(), toolCallDelta()]) {
      expect(isSemanticStreamFrame(semantic)).toBe(true);
    }
    expect(isSemanticStreamFrame(chunkFrame({ type: 'block-start', index: 3, blockType: 'text' }))).toBe(true);
    expect(isSemanticStreamFrame(chunkFrame({ type: 'block-start', index: 4, blockType: 'tool-call' }))).toBe(true);
    expect(isSemanticStreamFrame(chunkFrame({ type: 'block-end', index: 5, block: { type: 'tool-call', id: 'call-1', name: 'x', text: '' } }))).toBe(true);
    for (const liveness of [
      startFrame(), // the stream-opening marker
      endFrame(), // the terminal marker (its durable settlement rides session/event)
      reasoningDelta(), // the think phase's own wire traffic
      chunkFrame({ type: 'block-start', index: 6, blockType: 'reasoning' }),
      chunkFrame({ type: 'block-end', index: 7, block: { type: 'reasoning', text: 'hmm' } }),
      chunkFrame({ type: 'usage', usage: {} }),
      chunkFrame({ type: 'finish', reason: { kind: 'stop' } }),
      { agent: agentRef }, // a frame-less payload
      {}, // no payload at all
    ]) {
      expect(isSemanticStreamFrame(liveness)).toBe(false);
    }
  });
});

/** A minimal cordis-shaped context: records the mount's subscriptions and
 * replays payloads to them. `get('agents')` answers the registry face the
 * watchdog demands. */
const fakeCtx = (agents) => {
  const feeds = new Map();
  return {
    on(type, fn) {
      if (!feeds.has(type)) feeds.set(type, []);
      feeds.get(type).push(fn);
    },
    get: (name) => (name === 'agents' ? { list: () => [...agents] } : undefined),
    emit(type, payload) {
      for (const fn of feeds.get(type) ?? []) fn(payload);
    },
  };
};

describe('turn watchdog: a keepalive-only stream is rescued in-band (#346)', () => {
  it('markers + reasoning deltas forever still fails the turn within the budget', async () => {
    const agent = runningAgent('agent-346');
    const ctx = fakeCtx([agent]);
    apply(ctx, { budgetMs: 150 });
    ctx.emit('agent/status', { status: 'running', agent: agentRef }); // the turn starts (semantic, arms)
    ctx.emit('session/event', { type: 'turn/start' }); // durable boundary (semantic, re-arms)
    expect(agent.calls).toHaveLength(0);
    // The wedge: reasoning frames drip forever, well inside the budget window
    // each time — exactly the #346 "Deep diving…" shape. 25 frames x 40ms.
    for (let i = 0; i < 25; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      ctx.emit('agent/assistant-stream', startFrame());
      ctx.emit('agent/assistant-stream', reasoningDelta());
    }
    // The old any-frame feed would have re-armed through all 25 drips; the
    // semantic feed failed the turn in-band, with the existing vocabulary.
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0].cause.kind).toBe('watchdog');
    expect(agent.calls[0].cause.message).toContain('no turn progress for 150ms');
    expect(agent.calls[0].options).toEqual({ keepInbox: true });
  }, 10_000);
});

describe('turn watchdog: semantic progress still re-arms (no over-reach)', () => {
  it('answer text deltas keep the turn alive through 4x the budget', async () => {
    const agent = runningAgent('agent-text');
    const ctx = fakeCtx([agent]);
    apply(ctx, { budgetMs: 120 });
    ctx.emit('agent/status', { status: 'running', agent: agentRef });
    // A slow-but-alive ANSWER stream: one text delta every 40ms for 480ms —
    // 4x the budget in total, never one silent budget window.
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      ctx.emit('agent/assistant-stream', textDelta());
    }
    expect(agent.calls).toHaveLength(0);
  }, 10_000);
});
