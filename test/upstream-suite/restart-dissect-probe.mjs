// dsh:logging-exempt (probe: its verdict output IS the product)
/**
 * restart-dissect-probe.mjs — the faithful replica of agent-initiator.spec's
 * "drains the old driver before disabling ALS during agent-service restart",
 * instrumented: CP0 first request, CP1 the abort-catch initiator capture
 * (emits CAPTURE-THREW: <msg> when requireInitiator throws), CP2..CP5 the
 * post-restart world. On our runtime CP1 reports
 * "agent initiator scope is disposed" — the abort-observer continuation
 * runs AFTER the disposal state flip; Node runs it before (the test is
 * green under vitest). This ordering is the shared root of the remaining
 * agent-initiator failures; the generator/promise context probes all pass,
 * so it is NOT propagation — it is restart-teardown job ordering.
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

const textResponse = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  ...Array.from(text, (c) => ({ type: 'text-delta', index: 0, text: c })),
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
  { type: 'finish', reason: { kind: 'stop' } },
];
class ReloadAdapter extends LlmAdapter {
  firstStarted = Promise.withResolvers();
  firstAgentDuringAbort;
  laterAgent;
  abortCaptureError;
  calls = 0;
  agents;
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(options) {
    const agents = this.agents;
    if (agents === undefined) throw new Error('agent service missing');
    this.calls += 1;
    if (this.calls === 1) {
      this.firstStarted.resolve(true);
      try {
        await new Promise((_r, reject) => {
          const abort = () => { reject(new Error('aborted')); };
          if (options.signal?.aborted === true) abort();
          else options.signal?.addEventListener('abort', abort, { once: true });
        });
      } catch (error) {
        await Promise.resolve();
        try {
          this.firstAgentDuringAbort = agents.requireInitiator();
        } catch (e) {
          this.abortCaptureError = String(e?.message ?? e);
        }
        throw error;
      }
      return;
    }
    await Promise.resolve();
    this.laterAgent = agents.requireInitiator();
    yield* textResponse('reloaded');
  }
}
const send = (agent, text) => agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
const idlePromise = (ctx, agent) => new Promise((resolve) => {
  const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') { dispose(); resolve(); }
  });
});

describe('restart dissect', () => {
  it('drains the old driver before disabling ALS during agent-service restart', async () => {
    const adapter = new ReloadAdapter();
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    const agentsFiber = await ctx.plugin(AgentRegistry);
    const loopFiber = await ctx.plugin(AgentLoop, { agents: [] });
    ctx.llm.registerAdapter(['mock'], adapter);
    const oldService = ctx.agents;
    adapter.agents = oldService;
    const oldHandle = await ctx.agents.create({ sessionId: SessionId('before-restart-session'), agentOptions: { provider: 'mock', model: 'mock' } });
    const oldAgent = oldHandle.agent;
    send(oldAgent, 'block');
    // CP0: first request started (bounded — firstStarted is a plain promise)
    const got = await Promise.race([adapter.firstStarted.promise, new Promise((r) => { globalThis.setTimeout(() => r('STALLED'), 8000); })]);
    expect(got).toBe(true); // CP0
    await agentsFiber.restart();
    await loopFiber.await();
    expect(adapter.firstAgentDuringAbort?.id ?? `CAPTURE-THREW: ${adapter.abortCaptureError}`).toBe(oldAgent.id); // CP1
    expect(adapter.firstAgentDuringAbort?.session).toBe(oldAgent.session); // CP1b
    expect(() => oldService.currentInitiator()).toThrow(); // CP2
    expect(ctx.agents).not.toBe(oldService); // CP3
    adapter.agents = ctx.agents;
    const newHandle = await ctx.agents.create({ sessionId: SessionId('after-restart-session'), agentOptions: { provider: 'mock', model: 'mock' } });
    const newAgent = newHandle.agent;
    const idle = idlePromise(ctx, newAgent);
    send(newAgent, 'continue');
    const idleGot = await Promise.race([idle, new Promise((r) => { globalThis.setTimeout(() => r('IDLE-STALL'), 8000); })]);
    expect(idleGot).toBe(undefined); // CP4: idle resolved (undefined, not the stall string)
    expect(adapter.laterAgent?.id).toBe(newAgent.id); // CP5 — the spec's failing line family
    await ctx.fiber.dispose();
  });
});
