// dsh:logging-exempt (probe: its verdict output IS the product)
/**
 * cancel-dissect-probe.mjs — the checkpoint-bisecting replica of cancel.spec's
 * "replays replacement work queued synchronously by an abort observer": CP1
 * first request hangs, CP2 signal live, CP3 abort fired synchronously, CP4
 * idle reached, CP5 replacement dispatched (polled — the idle event fires
 * BEFORE kick's finally latches the wake). All checkpoints pass on our
 * runtime; the scaffold is the template for bisecting the remaining
 * agent-initiator failures.
 */
import { describe, it, expect } from 'scenario/upstream-test-harness.js';
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';

// MockAdapter-lite: 'hang' then scripted text replies, like the spec's.
class MiniAdapter extends LlmAdapter {
  requests = [];
  script;
  constructor(script) { super(); this.script = [...script]; }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model });
  }
  async *stream(options) {
    this.requests.push(options);
    const entry = this.script.shift();
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'partial' };
      await new Promise((_r, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return; }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true });
      });
      return;
    }
    for (const chunk of entry) { if (options.signal?.aborted) throw new Error('aborted'); yield chunk; }
  }
}
const textResponse = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  ...Array.from(text, (char) => ({ type: 'text-delta', index: 0, text: char })),
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
  { type: 'finish', reason: { kind: 'stop' } },
];

describe('cancel dissect', () => {
  it('replacement replay after abort-observer queue', async () => {
    const adapter = new MiniAdapter(['hang', textResponse('replacement reply'), textResponse('wake reply')]);
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    ctx.llm.registerAdapter(['mock'], adapter);
    const agent = await ctx.agentLoop.create(SessionId('dissect-1'), { provider: 'mock', model: 'mock' });
    const send = (text) => agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    const idle = new Promise((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { dispose(); resolve('idle'); }
      });
    });
    send('original');
    // CP1: first request runs and hangs
    for (let i = 0; i < 80 && adapter.requests.length < 1; i++) {
      await new Promise((r) => { globalThis.setTimeout(r, 25); });
    }
    expect(adapter.requests.length).toBe(1); // CP1
    const signal = adapter.requests[0].signal;
    expect(signal !== undefined && signal.aborted).toBe(false); // CP2
    signal.addEventListener('abort', () => { send('replacement'); }, { once: true });
    const whenIdle = agent.whenIdle();
    agent.cancel({ kind: 'user' });
    // CP3: abort fired synchronously
    expect(signal.aborted).toBe(true);
    // CP4: wait for idle (event-based) with a generous window
    const got = await Promise.race([idle, new Promise((r) => { globalThis.setTimeout(() => r('TIMEOUT'), 8000); })]);
    expect(got).toBe('idle'); // CP4 — the divergence point if not idle
    // CP5: replacement dispatched? (poll like the real test — the idle
    // event fires BEFORE kick's finally latches the wake)
    for (let i = 0; i < 200 && adapter.requests.length < 2; i++) {
      await new Promise((r) => { globalThis.setTimeout(r, 25); });
    }
    expect(adapter.requests.length).toBe(2); // CP5
    await whenIdle;
    expect(agent.inbox.nextTurn).toHaveLength(0);
  });
});
