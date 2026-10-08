// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * boot-subagent-rows.js — the SUBAGENT row's mounts (split from boot.js at
 * the code-size gate, the boot-coverage-rows shape): the vendored
 * @deepseek-ai/dsh-subagent control-plane runtime plus the live-preferred
 * query engine its catalog demands. Imported by boot.js AFTER the
 * settings/projection mounts (the runtime's injects wait for services, so
 * the order is courtesy, not correctness).
 */
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent';

/** Mount the subagent control plane onto the booted spine.
 * @param ctx - the spine context (settings/agents/sessionProjections live).
 */
export const mountSubagentRows = async (ctx) => {
  // The live-preferred session query engine (the subagent catalog's corpus
  // source; live-only on this profile — no persistence backend is mounted).
  await ctx.plugin(SessionQueryEngine);
  // The subagent control plane (T-0050 item 2): injects settings + agents +
  // sessionProjections, registers its catalog/timing/identity projections,
  // and serves subagents/list + /prompt + /interruptByParent. No provider
  // registers here — delegation stays unavailable and the catalog stays
  // honestly empty until a provider composition lands (the schema defaults:
  // depth 1, 8 active children).
  await ctx.plugin(SubagentRuntime, { maxDepth: 1, maxActiveSubagents: 8 });
};
