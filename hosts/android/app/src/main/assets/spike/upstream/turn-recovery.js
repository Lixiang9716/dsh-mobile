/**
 * upstream/turn-recovery.js — the turn-failure supervisor (loop-u).
 *
 * The vendored turn state machine is fail-stop by default: a step whose LLM
 * attempt dies (stream cut mid-frame, transport refused) throws LlmError out
 * of the turn; the driver's kick() swallows it and goes idle, and its re-arm
 * needs `wakeRequested && inbox.hasPending` — but `wakeRequested` only latches
 * for messages that arrive AFTER the abort signal fired (dsh-agent-loop
 * lib/index.js kick()/wakeDriver()/send()). A followup queued behind a
 * healthily RUNNING turn never latches it, so when that turn later dies the
 * queued message strands forever: no closing assistant text (the client
 * renders journal MESSAGES, and an errored turn appends only lifecycle
 * events), no error surfaced (the desktop controller relays `agent/error` to
 * its API face — dsh-api-session-controller lib/index.js:2727 — and the
 * mobile compose had no subscriber at all), and every already-queued user
 * prompt silently dropped (the r11 battery's V1 sessions).
 *
 * Two upstream-aligned halves, both mobile-layer wiring (vendored files are
 * never edited):
 *
 * 1. `@deepseek-ai/dsh-llm-retry` (mounted next to this plugin in boot.js)
 *    answers `agent/request-error` with the provider's retry policy — a
 *    transient stream death retries the REQUEST in-turn and most blips never
 *    become errored turns at all.
 * 2. This supervisor covers what a retry budget cannot: when a turn still
 *    ends in error, the boundary is made HONEST (one durable system message
 *    on the session journal, visible in chat) and the queued followups
 *    CONTINUE per the existing followup semantics (the driver is re-armed
 *    exactly when the errored turn left pending inbox work).
 *
 * Re-arm mechanics: `wakeDriver` is private in the vendored ReactLoopAgent
 * type but is the one driver entry (send() with wakeup=true would have to
 * insert a synthetic user message — a conversation-semantics lie). The call
 * is guarded: a vendor pin that removes it degrades to a loud warn, never a
 * crash inside an event listener.
 */
import { createLogger } from 'logger.js';
import { createSystemMessage, errorChain } from '@deepseek-ai/dsh-llm';

const log = createLogger('dsh.turn-recovery');

export const name = 'turn-recovery';

export const inject = ['agents'];

/** Message source tag the durable note carries (createSystemMessage's plugin
 * field) — names the supervisor in the journal. */
const SOURCE = 'dsh-turn-recovery';

export const apply = (ctx) => {
    const registry = ctx.get('agents');
    if (registry === undefined || typeof registry.list !== 'function') {
        throw new Error('turn-recovery: the agents registry (ctx.agents.list) is not mounted');
    }
    /** agentId → the failure text recorded at its live boundary. One mark per
     * error; cleared when the idle boundary consumes it (one note per failed
     * turn, never a storm across the status events a long session emits). */
    const failed = new Map();

    ctx.on('agent/error', ({ agent, error }) => {
        const message = errorChain(error);
        failed.set(agent.id, message);
        log.warn('turn failed', { agent: agent.id, reason: message });
    });

    ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle') return;
        const reason = failed.get(agent.id);
        if (reason === undefined) return;
        failed.delete(agent.id);
        recoverFromFailedTurn(agent, reason);
    });

    log.info('turn recovery mounted', {
        onErroredTurn: 'one durable system message + re-arm the driver when followups are queued',
    });
};

/** The idle boundary of one errored turn: append the honest note (visible in
 * chat — the client renders journal messages, not lifecycle events), then
 * re-arm the driver when followups stranded in the inbox. */
const recoverFromFailedTurn = (agent, reason) => {
    const pending = agent.inbox?.hasPending === true;
    try {
        agent.session.append('system/message', {
            message: createSystemMessage(
                `Turn failed: ${reason}${pending
                    ? ' — the queued messages continue next.'
                    : '.'}`,
                SOURCE,
            ),
        });
    } catch (error) {
        // The note must never mask the recovery below; the journal already
        // carries turn/end{reason:error} as the durable record.
        log.warn('failure note append failed', {
            agent: agent.id,
            reason: `${error?.message ?? error}`,
        });
    }
    if (!pending) return;
    if (typeof agent.wakeDriver !== 'function') {
        log.warn('cannot re-arm stranded inbox: the vendored agent face has no wakeDriver', {
            agent: agent.id,
            queued: true,
        });
        return;
    }
    log.info('re-arming driver for queued messages after a failed turn', { agent: agent.id });
    agent.wakeDriver();
};
