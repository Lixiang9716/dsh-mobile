// dsh:logging-exempt (pure data machinery: no I/O — the driver boundary owns logging)
/**
 * fold.js — the view events → view state fold (a pure state machine, the
 * clarklevis projection pattern). Shared by BOTH skins: the stub skin
 * transcribes from it in plain text; the ReactLynx bundle folds into the
 * same shape and renders it declaratively. One file, one behavior — the
 * two faces cannot drift.
 *
 * Ported from web-client-next's timeline.js, narrowed to the view-event
 * vocabulary (the domain→view translation lives in driver/adapter.js):
 *
 *   message-delta    → the streaming tail (text + reasoning + building
 *                      tool cards); 'end' marks the tail terminal
 *   tool-card-phase  → tool items keyed by callId (streaming builder →
 *                      waiting → ok/fail with output)
 *   session-settled  → user bubble, assistant markdown (promotes the tail
 *                      of the same turn:step), creation card, title,
 *                      turn-end status, drawer sessions, connection,
 *                      prompt-admitted (optimistic running), system rows,
 *                      seed-start/seed-end (the cold-start snapshot burst:
 *                      seed-start resets, seed-end completes it)
 *
 * Item shapes are the timeline.js shapes (user/assistant/reasoning/tool/
 * status/system/notice/creation) so the transcription parity with the web
 * client is checkable line for line.
 */

import { assertViewEvent } from './view-events.js';

const NORMAL_TURN_REASONS = new Set(['stop', 'tool-calls', 'completed']);

export const makeFoldState = () => ({
  items: [],
  byCall: new Map(), // callId → tool item
  streamed: new Set(), // `${turn}:${step}` steps whose reasoning streamed live
  tail: null,
  title: undefined,
  sessions: [], // drawer items: {sessionId, updatedAt, running, blank}
  connection: 'connecting',
  pendingPrompt: false, // a submitted prompt admitted, no stream frame yet
  seedComplete: false,
});

const keyFor = (turn, step) => `${turn}:${step}`;

const add = (state, item) => {
  state.items.push(item);
  return item;
};

export const isRunning = (state) => state.tail !== null || state.pendingPrompt;

const textOf = (blocks, type) => (Array.isArray(blocks) ? blocks : [])
  .filter((block) => block?.type === type)
  .map((block) => block.text)
  .join('');

// ---- message-delta ---------------------------------------------------------

const ensureTail = (state, event) => {
  if (state.tail !== null && state.tail.attemptId === event.attemptId) return state.tail;
  state.tail = {
    turn: event.turn, step: event.step, attemptId: event.attemptId,
    text: '', reasoning: '', tools: new Map(), streaming: false,
  };
  state.pendingPrompt = false; // the live signal retires the optimistic state
  return state.tail;
};

const applyDelta = (state, event) => {
  if (event.kind === 'start') {
    ensureTail(state, event);
    return;
  }
  if (event.kind === 'end') {
    if (state.tail?.attemptId === event.attemptId) {
      state.tail.streaming = false; // terminal; the durable message promotes the text
    }
    return;
  }
  const tail = ensureTail(state, event);
  if (event.kind === 'text') {
    tail.text += event.text;
    tail.streaming = true;
  } else {
    tail.reasoning += event.text;
    state.streamed.add(keyFor(tail.turn, tail.step));
  }
};

// ---- tool-card-phase -------------------------------------------------------

const applyToolPhase = (state, event) => {
  if (event.phase === 'streaming') {
    const tail = state.tail ?? ensureTail(state, { ...event, attemptId: 'unknown' });
    let tool = tail.tools.get(event.callId);
    if (tool === undefined) {
      tool = { id: event.callId, name: '', args: '' };
      tail.tools.set(event.callId, tool);
    }
    if (event.name !== undefined) tool.name = event.name;
    tool.args += event.argsDelta;
    return;
  }
  if (event.phase === 'waiting') {
    const existing = state.byCall.get(event.callId);
    if (existing !== undefined) {
      // A streamed builder became this pending card; the durable call names it.
      if (existing.status === 'waiting' && existing.name === 'tool') {
        existing.name = event.name;
        existing.args = event.args;
      }
      return;
    }
    const item = add(state, {
      kind: 'tool', callId: event.callId, name: event.name, args: event.args,
      status: 'waiting', output: '', turn: 0, step: 0,
    });
    state.byCall.set(event.callId, item);
    return;
  }
  // ok | fail: the result settles the card (or lands one for an unseen call)
  const failed = event.phase === 'fail';
  const item = state.byCall.get(event.callId);
  if (item === undefined) {
    add(state, {
      kind: 'tool', callId: event.callId, name: event.name ?? 'tool', args: '',
      status: failed ? 'fail' : 'ok', output: event.output, turn: 0, step: 0,
    });
    return;
  }
  item.status = failed ? 'fail' : 'ok';
  item.output = event.output;
};

// ---- session-settled -------------------------------------------------------

const promoteTail = (state, turn, step) => {
  if (state.tail === null || state.tail.turn !== turn || state.tail.step !== step) return;
  if (state.tail.reasoning !== '') {
    add(state, { kind: 'reasoning', text: state.tail.reasoning, turn, step });
  }
  for (const tool of state.tail.tools.values()) {
    if (!state.byCall.has(tool.id)) {
      const item = add(state, {
        kind: 'tool', callId: tool.id, name: tool.name || 'tool',
        args: tool.args, status: 'waiting', output: '', turn, step,
      });
      state.byCall.set(tool.id, item);
    }
  }
  state.tail = null;
};

const applyAssistantMessage = (state, event) => {
  promoteTail(state, event.turn, event.step);
  if (event.reasoning !== '' && !state.streamed.has(keyFor(event.turn, event.step))) {
    add(state, {
      kind: 'reasoning', text: event.reasoning,
      turn: event.turn, step: event.step,
    });
  }
  add(state, {
    kind: 'assistant', markdown: event.markdown,
    interrupted: event.interrupted, turn: event.turn, step: event.step,
  });
};

const applyTurnEnd = (state, event) => {
  state.pendingPrompt = false;
  state.tail = state.tail === null ? null : { ...state.tail, streaming: false };
  if (NORMAL_TURN_REASONS.has(event.reason)) return;
  if (event.reason === 'aborted' || event.reason === 'cancelled') {
    // A cancelled turn gets NO promoting assistant/message — drop the
    // streaming tail here or it hangs (and pins the stop button on).
    state.tail = null;
    add(state, { kind: 'status', text: '已停止', tone: 'info' });
    return;
  }
  add(state, { kind: 'status', text: `回合结束（${event.reason}）`, tone: 'warn' });
};

const applySeed = (state, event) => {
  if (event.kind === 'seed-start') {
    const fresh = makeFoldState();
    fresh.connection = state.connection;
    fresh.sessions = state.sessions;
    Object.assign(state, fresh);
    return;
  }
  state.seedComplete = true;
  state.pendingPrompt = false;
};

const applySettled = (state, event) => {
  switch (event.kind) {
    case 'user-message':
      add(state, {
        kind: 'user', text: event.text,
        images: Array.isArray(event.images) ? event.images : [],
      });
      break;
    case 'assistant-message': applyAssistantMessage(state, event); break;
    case 'creation':
      add(state, { kind: 'creation', files: event.files });
      break;
    case 'title':
      state.title = event.title;
      break;
    case 'turn-end': applyTurnEnd(state, event); break;
    case 'status':
      add(state, { kind: 'status', text: event.text, tone: event.tone });
      break;
    case 'sessions':
      state.sessions = event.items;
      break;
    case 'connection':
      state.connection = event.status;
      break;
    case 'prompt-admitted':
      state.pendingPrompt = true;
      break;
    case 'system':
      add(state, { kind: 'system', label: event.label, types: [event.source] });
      break;
    case 'seed-start': case 'seed-end': applySeed(state, event); break;
    default:
      throw new TypeError(`fail loud: unhandled settled kind: ${event.kind}`);
  }
};

/** Apply one (already validated) view event; mutates `state` in place —
 * the purity contract is "state is a pure function of the event order",
 * not immutability. */
export const applyViewEvent = (state, event) => {
  assertViewEvent(event);
  if (event.type === 'message-delta') applyDelta(state, event);
  else if (event.type === 'tool-card-phase') applyToolPhase(state, event);
  else applySettled(state, event);
};

/** The fold over the closed view-event set. */
export const createFold = () => {
  const state = makeFoldState();
  return {
    state,
    apply: (event) => applyViewEvent(state, event),
  };
};

/** A plain-data snapshot of the fold state for declarative renderers
 * (Maps spread into arrays; list identity changes so React reconciles). */
export const snapshotState = (state) => ({
  items: state.items.slice(),
  tail: state.tail === null ? null : {
    turn: state.tail.turn, step: state.tail.step, attemptId: state.tail.attemptId,
    text: state.tail.text, reasoning: state.tail.reasoning, streaming: state.tail.streaming,
    tools: [...state.tail.tools.values()].map((tool) => ({ ...tool })),
  },
  title: state.title,
  sessions: state.sessions.slice(),
  connection: state.connection,
  running: isRunning(state),
  seedComplete: state.seedComplete,
});
