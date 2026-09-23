#!/usr/bin/env node
// dsh:logging-exempt (node-side test vehicle: its stdout IS the product)
/**
 * parity-reference — the NODE REFERENCE LEG of the upstream parity check.
 *
 * The SAME vendored upstream packages the quickjs port runs (0.1.6-alpha.2,
 * sha256-pinned by vendor/ensure-dsh.sh — never edited, D6/D9) are composed
 * here under plain Node, the host upstream itself targets: real ESM, real
 * V8, no shims. The spine is the shared subset of the mobile profile boot
 * (runtime/spike/upstream/boot.js MOBILE_LAYERS): llm first (the vendored
 * LlmRuntime with the REAL gateway transport adapter, imported VERBATIM —
 * ci/parity-node-hooks.mjs redirects its one gateway import to the Node
 * bridge), then session → agent → system-prompt → tools →
 * session-projection → settings (the same in-memory provider) → tool-todo →
 * agent-loop, with the same plugin configs and the same identities as the
 * port leg. What is deliberately NOT mounted: the platform shell executors
 * and the fs/file-tools rows (they are gateway-bound system plugins — the
 * mobile profile's additions beyond the shared spine).
 *
 * The mock wire is the vendored dsh-llm-mock-server, the same server the
 * port leg talks to. The driver prints one `PARITY_EVENT <json>` line per
 * projected session record (the SHARED projector, scenario/parity-projector.js)
 * plus `PARITY_SUMMARY <json>`; ci/parity-compare.mjs diffs these against
 * the port leg's projection of the same scripted turns.
 *
 * usage: node ci/parity-reference.mjs   (env: DSH_MOCK_LLM_URL, DSH_MOCK_LLM_KEY)
 */
import { register } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./parity-node-hooks.mjs', import.meta.url);

const SESSION_ID = 's-upstream-parity-0001';
const AGENT_ID = 'main';
const TURN1_TEXT = 'Say hello';
const TURN2_TEXT = 'Track the parity check';

const fail = (message) => {
  console.error(`parity-reference: ${message}`);
  process.exit(1);
};

const env = { ...process.env };
if (typeof env.DSH_MOCK_LLM_URL !== 'string' || !env.DSH_MOCK_LLM_URL.startsWith('http://127.0.0.1:')) {
  fail(`DSH_MOCK_LLM_URL missing or not loopback: ${String(env.DSH_MOCK_LLM_URL)}`);
}
if (typeof env.DSH_MOCK_LLM_KEY !== 'string' || env.DSH_MOCK_LLM_KEY.length === 0) {
  fail('DSH_MOCK_LLM_KEY missing');
}

// The reference's profile container: a real Node temp dir (upstream under its
// intended host touches a real filesystem; the parity projection masks the
// container paths, so the two legs need not share them).
const containerRoot = mkdtempSync(join(tmpdir(), 'dsh-parity-ref-'));

const { Context } = await import('@deepseek-ai/cordis');
const { SessionStore } = await import('@deepseek-ai/dsh-session');
const { AgentRegistry } = await import('@deepseek-ai/dsh-agent');
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools');
const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection');
const { LlmRuntime } = await import('@deepseek-ai/dsh-llm');
const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
const { AgentLoop } = await import('@deepseek-ai/dsh-agent-loop');
const ToolTodo = await import('@deepseek-ai/dsh-tool-todo');
const { SettingsMemory } = await import('../upstream/settings-memory.js');
const { createGatewayLlmAdapter } = await import('../upstream/llm-transport.js');
const { projectSessionEvents } = await import('../scenario/parity-projector.js');

/** Mount `llm` first (the same order as the port leg's boot.js): the
 * vendored LlmRuntime with the REAL gateway transport adapter. */
const bootLlm = async (ctx) => {
  await ctx.plugin(LlmRuntime);
  const runtime = ctx.get('llm');
  if (runtime === undefined) fail('the LlmRuntime failed to mount under "llm"');
  runtime.registerAdapter(['mock'], createGatewayLlmAdapter({
    baseURL: env.DSH_MOCK_LLM_URL,
    apiKey: env.DSH_MOCK_LLM_KEY,
    provider: 'mock',
    name: 'parity reference transport (node httpFetch bridge)',
  }));
};

/** Mount the spine rows (the same mounts and configs as the port leg's
 * boot.js subset, in the MOBILE_LAYERS order). */
const bootSpine = async (ctx) => {
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SystemPrompt, { personaPrefix: '' });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SettingsMemory);
  await ctx.plugin(ToolTodo, { allowParallelInProgress: false });
  await ctx.plugin(AgentLoop, {
    maxParallelToolCalls: 10,
    agents: [{
      id: AGENT_ID,
      sessionId: SESSION_ID,
      provider: 'mock',
      model: 'mock-1',
      reasoningEffort: 'off',
      cwd: containerRoot,
    }],
  });
};

/** Compose the shared spine (llm first, then the layers), then demand every
 * spine service mounted (fail loud, the same demand as boot.js). */
const boot = async () => {
  const ctx = new Context();
  await bootLlm(ctx);
  await bootSpine(ctx);
  for (const key of ['sessions', 'agents', 'systemPrompt', 'tools', 'sessionProjections', 'settings', 'agentLoop', 'llm']) {
    if (ctx.get(key) === undefined) fail(`service "${key}" failed to mount`);
  }
  return ctx;
};

const driveTurn = async (agent, text) => {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
};

const awaitAgent = async (ctx) => {
  let guard = 0;
  while ((ctx.agents.get(SESSION_ID) === undefined || ctx.sessions.get(SESSION_ID) === undefined)
    && guard++ < 10000) {
    await Promise.resolve();
  }
  const agent = ctx.agents.get(SESSION_ID);
  if (agent === undefined) fail(`agent "${SESSION_ID}" never appeared in the registry`);
  return agent;
};

/** Print the projected session log (+ raw records under PARITY_DEBUG=1) and
 * the projection-plane summary. */
const reportSession = (ctx, session) => {
  const projected = projectSessionEvents(session.snapshotEvents());
  for (const record of projected) {
    console.log(`PARITY_EVENT ${JSON.stringify(record)}`);
  }
  if (process.env.PARITY_DEBUG === '1') {
    for (const record of session.snapshotEvents()) {
      console.log(`PARITY_RAW ${JSON.stringify(record)}`);
    }
  }
  const turnBoundary = ctx.sessionProjections.stateOf(session, 'turnBoundary');
  const todos = ctx.sessionProjections.stateOf(session, 'todos');
  console.log(`PARITY_SUMMARY ${JSON.stringify({
    events: projected.length,
    turnBoundary: turnBoundary?.lastTurn ?? null,
    todos: todos ?? null,
  })}`);
};

/** The transport-error leg (the mock's scripted 401) — the reference's
 * error-finish is compared against the port leg's recorded
 * llm/transport/error event, so print it too. */
const reportErrorLeg = async (ctx) => {
  const stream = ctx.llm.stream({
    provider: 'mock',
    model: 'mock-1',
    messages: [createUserMessage({ content: [{ type: 'text', text: TURN1_TEXT }], source: { kind: 'user' } })],
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const [finish] = chunks;
  console.log(`PARITY_ERROR_LEG ${JSON.stringify({
    chunks: chunks.length,
    type: finish?.type ?? null,
    kind: finish?.reason?.kind ?? null,
    code: finish?.reason?.failure?.code ?? null,
  })}`);
};

const main = async () => {
  const ctx = await boot();
  const agent = await awaitAgent(ctx);

  await driveTurn(agent, TURN1_TEXT);
  await driveTurn(agent, TURN2_TEXT);

  const session = ctx.sessions.get(SESSION_ID);
  if (session === undefined) fail('session vanished from the store');

  reportSession(ctx, session);
  await reportErrorLeg(ctx);
  process.exit(0);
};

main().catch((error) => fail(error?.stack ?? String(error)));
