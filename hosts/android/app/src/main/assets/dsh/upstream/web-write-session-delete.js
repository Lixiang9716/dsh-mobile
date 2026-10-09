// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-session-delete.js — the seat's session teardown leg
 * (split from web-write.js at the code-size gate; the SD track, 2026-10-10).
 *
 * NO upstream session/delete exists at the pin (packages/api/
 * session-controller has no delete command, and the vendored
 * @deepseek-ai/dsh-session store exposes no delete/forget — its only
 * removal path is the detach disposer `enter()` returns), so the semantics
 * align with the vendored teardown primitive that DOES exist: the
 * AgentHandle.dispose capability (@deepseek-ai/dsh-agent
 * lib/types/index.d.ts) — "stops the loop, awaits its exit, unregisters
 * the agent, removes its session from the store, and finally unwinds its
 * scoped world", emitting agent/disposed + session/disposed. This surface
 * is the seat that created the session (create + fork both capture their
 * handle's dispose into deps.agentDisposes), so the capability contract
 * ("among consumers, only the holder can tear this agent down") holds by
 * construction. The narrowed decisions:
 *   - RUNNING REFUSES with session/agent-busy (the controller's own
 *     mid-work refusal code, commands.prompt's): a turn's partial output
 *     is user-visible state and session/cancel is the explicit verb for
 *     stopping it — silently killing a watched turn is a destructive
 *     surprise. The vendored dispose WOULD drain it; we decline first.
 *   - NO JOURNAL FILE deletes: the mobile profile mounts no persistence
 *     backend (boot.js config.agents create path — no sessionPersistence;
 *     upstream/shims/dsh-session-persistence.js is linkage-errors-only),
 *     so the in-memory store removal IS the whole deletion.
 *   - The boot carrier (loop-fiber-owned, no handle held here) refuses
 *     with gateway/unavailable — the capability contract's honest face.
 *   - The page projections answer from the store alone: session/list
 *     stops carrying the id, session/page (and every session-addressing
 *     handler) answers session/not-found through the shared resolution.
 *   - The workspace registry drops the id (the seeded workspace's
 *     sessionIds) and the upsert fans to every open workspace/follow —
 *     the same channel attachWorkspace published on.
 */
import { remoteError } from 'upstream/web-write.js';
import { createLogger } from 'logger.js';

const log = createLogger('web-write');

/** session/delete: one page-created session retired through the vendored
 * AgentHandle.dispose (the narrowed decisions above live in this file's
 * header). */
export const makeSessionDeleteHandlers = (ctx, deps) => ({
  'session/delete': async (args) => {
    const request = args?.request ?? args;
    if (request === null || typeof request !== 'object'
      || typeof request.sessionId !== 'string') {
      throw remoteError('gateway/bad-request',
        'delete request needs sessionId', {});
    }
    const agent = ctx.agents.get(request.sessionId);
    if (agent === undefined) {
      throw remoteError('session/not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId });
    }
    if (agent.status === 'running') {
      throw remoteError('session/agent-busy',
        `session "${request.sessionId}" is running — cancel the turn `
          + 'before deleting',
        { sessionId: request.sessionId, reason: 'running' });
    }
    const dispose = deps.agentDisposes.get(request.sessionId);
    if (dispose === undefined) {
      throw remoteError('gateway/unavailable',
        `session "${request.sessionId}" has no dispose capability held by `
          + 'this seat (the boot carrier is loop-owned)',
        { sessionId: request.sessionId, reason: 'no-dispose-capability' });
    }
    await dispose();
    // Unregistered only after the dispose settled — a thrown teardown keeps
    // the capability so the delete can be retried.
    deps.agentDisposes.delete(request.sessionId);
    for (const workspace of deps.workspaces.values()) {
      if (!workspace.sessionIds.includes(request.sessionId)) continue;
      workspace.sessionIds = workspace.sessionIds.filter(
        (id) => id !== request.sessionId);
      workspace.updatedAt = new Date().toISOString();
      deps.streams.publish({
        type: 'upsert',
        workspace: { ...workspace, sessionIds: [...workspace.sessionIds] },
      });
    }
    log.debug('session deleted', { sessionId: request.sessionId });
    return { accepted: true };
  },
});
