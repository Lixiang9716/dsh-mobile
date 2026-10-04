/**
 * upstream/turn-watchdog.js — the turn-level watchdog (issue #323, ring 2).
 *
 * The per-tool deadline (upstream/tool-deadline.js) bounds tool dispatch;
 * a turn can still wedge OUTSIDE it — an LLM stream that stalls mid-frame,
 * a loop-internal await that never settles. This watchdog arms a re-armable
 * timer that SEMANTIC turn progress feeds (durable session journal appends,
 * agent status transitions, and within the assistant stream only answer
 * text and tool calls); when a full budget passes with NO semantic progress
 * while an agent is running, it fails the turn IN-BAND: the running
 * agent(s) are cancelled with a `watchdog` cause (keepInbox — queued user
 * messages are not the wedge), the loop unwinds at its next await boundary,
 * and the journal records the abort honestly.
 *
 * Why the assistant-stream feed is filtered (#346): the loop emits one
 * `agent/assistant-stream` event per stream FRAME — the start/end markers
 * and every chunk, including reasoning deltas. A long think phase ("Deep
 * diving…", the >15-min stall the real-model battery measured) is exactly a
 * steady drip of reasoning frames with zero durable progress behind them;
 * counting frames counts wire liveness, and the watchdog never fires. The
 * semantic filter (isSemanticStreamFrame) is the fix: wire keepalives and
 * reasoning traffic never re-arm the timer; answer text and tool calls do.
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
 * call (ring 1); the outer ring only trips when the WHOLE spine went
 * semantically quiet — 5 minutes with no durable turn message, no status
 * transition, and no answer text/tool-call frame on a running agent. */
export const DEFAULT_BUDGET_MS = 300_000;

/** The StreamChunk types (vendored dsh-llm types.ts) whose frame carries
 * SEMANTIC assistant progress: the model produced answer text or is
 * assembling a tool call. Deliberately absent: `reasoning-delta` (the think
 * phase's own wire traffic — transient frames, nothing durable behind them
 * until the attempt settles) and `usage`/`finish` (accounting/terminal
 * framing whose durable settlement reaches us as `session/event`). */
const SEMANTIC_CHUNK_TYPES = new Set(['text-delta', 'tool-call-delta']);

/** The ContentBlock types that count when a block-start/block-end frame
 * names them (an answer block opening/closing, a tool call assembling);
 * `reasoning` blocks are the think phase and never count. */
const SEMANTIC_BLOCK_TYPES = new Set(['text', 'tool-call']);

/** Decide whether one `agent/assistant-stream` event payload is semantic
 * progress. The payload is `{ agent, frame }` (dsh-agent's fused dispatch);
 * the frame is `{ type: 'start' | 'chunk' | 'end', chunk? }`. Only a chunk
 * frame naming answer text or a tool call in any form counts; stream
 * markers, reasoning deltas, and provider keepalive-shaped frames are wire
 * liveness and never re-arm the timer. */
export const isSemanticStreamFrame = (payload) => {
  const frame = payload?.frame;
  log.debug('stream frame classify', { frameType: frame?.type, chunkType: frame?.chunk?.type });
  if (frame?.type !== 'chunk') return false; // start/end are framing markers
  const chunk = frame.chunk;
  if (chunk === null || typeof chunk !== 'object') return false;
  if (SEMANTIC_CHUNK_TYPES.has(chunk.type)) return true;
  if (chunk.type === 'block-start' || chunk.type === 'block-end') {
    const blockType = chunk.type === 'block-start' ? chunk.blockType : chunk.block?.type;
    return SEMANTIC_BLOCK_TYPES.has(blockType);
  }
  return false;
};

/** The progress feeds a live turn emits, each paired with its semantic
 * predicate. `session/event` is dsh-session's append dispatch (every durable
 * turn message — turn boundaries, user/system/assistant messages, tool
 * events) and `agent/status` is dsh-agent-loop's status-transition emission
 * (change-only: a wedged phase emits no transitions) — both are semantic by
 * construction. */
const PROGRESS_FEEDS = [
  ['session/event', () => true],
  ['agent/status', () => true],
  ['agent/assistant-stream', isSemanticStreamFrame],
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
  for (const [event, semantic] of PROGRESS_FEEDS) {
    // the disposers ride the plugin fiber (cordis tracks them); the timer
    // self-neutralizes after teardown because listRunning() empties. The
    // predicate gates WIRE liveness out (reasoning deltas, stream markers —
    // #346): only semantic progress re-arms the budget.
    ctx.on(event, (payload) => {
      if (!semantic(payload)) return;
      watchdog.markProgress();
    });
  }
  log.info('turn watchdog mounted', {
    budgetMs,
    feeds: PROGRESS_FEEDS.map(([event]) => event),
    assistantStreamFeed: 'semantic-only (text/tool-call frames; reasoning & markers excluded)',
  });
};
