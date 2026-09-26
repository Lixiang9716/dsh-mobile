// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * timeline.js — the journal → display-items fold (the clarklevis projection
 * pattern, narrowed to v1). One session's follow feed — durable records
 * ({type:'event'}) interleaved with assistant-stream frames — folds into an
 * ordered item list the renderer maps 1:1 to DOM:
 *
 *   user/message (source user) → user bubble; injected sources → notice
 *   assistant/message          → assistant markdown (interrupted marked)
 *   tool/call + tool/result   → tool card keyed by callId (waiting → ok/fail)
 *   assistant/attempt, llm/retry, turn/end(abnormal), compaction → status
 *   system/message, todo/write, unknown types → collapsed system group
 *   session/title             → meta.title (nav header)
 *
 * Streaming: start/chunk/end frames accumulate into ONE tail (text +
 * reasoning + building tool cards); the durable assistant/message of the
 * same (turn, step) promotes the text to the final markdown item and
 * freezes streamed tool cards as pending until their durable tool/call
 * fills them. Notification is two-tier: 'structure' (re-render) and 'tail'
 * (append-only, rAF-coalesced by the caller).
 *
 * The fold itself is a module-level state machine over a plain `state`
 * object (createFold); createTimeline only wraps it in the subscription
 * machinery — the code-size gate keeps functions ≤50 lines.
 */

const PROMPT_SOURCE = 'user';
const NORMAL_TURN_REASONS = new Set(['stop', 'tool-calls', 'completed']);
// Per-turn prompt-assembly plumbing: durable but never user-facing (the
// official UI shows them in its context inspector; a chat transcript
// renders two noise rows per turn otherwise).
const SILENT_EVENT_TYPES = new Set(['request/header', 'request/context']);

const makeState = () => ({
  items: [],
  byCall: new Map(), // callId → tool item
  streamed: new Set(), // `${turn}:${step}` steps whose reasoning streamed live
  tail: null,
  title: undefined,
});

const keyFor = (turn, step) => `${turn}:${step}`;

const add = (state, item) => {
  state.items.push(item);
  return item;
};

const textOf = (blocks, type) => (Array.isArray(blocks) ? blocks : [])
  .filter((block) => block?.type === type)
  .map((block) => block.text)
  .join('');

// ---- durable events -------------------------------------------------------

const applyUserMessage = (state, data) => {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = textOf(blocks, 'text');
  if (data?.source?.kind !== PROMPT_SOURCE) {
    add(state, { kind: 'notice', label: '上下文', text: text || '(非文本上下文)' });
  } else {
    add(state, {
      kind: 'user',
      text,
      images: blocks.filter((block) => block?.type === 'image'),
    });
  }
};

const applyAssistantMessage = (state, data) => {
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
  const turn = data?.turn ?? 0;
  const step = data?.step ?? 0;
  promoteTail(state, turn, step);
  const reasoning = textOf(blocks, 'reasoning');
  if (reasoning !== '' && !state.streamed.has(keyFor(turn, step))) {
    add(state, { kind: 'reasoning', text: reasoning, turn, step });
  }
  const interrupted = data?.interrupted === true;
  add(state, { kind: 'assistant', markdown: textOf(blocks, 'text'), interrupted, turn, step });
  if (interrupted) recordInterruptedCalls(state, blocks, turn, step);
};

const recordInterruptedCalls = (state, blocks, turn, step) => {
  for (const block of blocks) {
    if (block?.type !== 'tool-call' || state.byCall.has(block.id)) continue;
    const item = add(state, {
      kind: 'tool', callId: block.id, name: block.name,
      args: block.arguments, status: 'fail', output: '已中断', turn, step,
    });
    state.byCall.set(block.id, item);
  }
};

const applyToolCall = (state, data) => {
  const existing = state.byCall.get(data?.callId);
  if (existing !== undefined) {
    // A streamed builder became this pending card; the durable call names it.
    if (existing.status === 'waiting' && existing.name === 'tool') {
      existing.name = data?.name ?? existing.name;
      if (data?.arguments) existing.args = data.arguments;
    }
    return;
  }
  const item = add(state, {
    kind: 'tool',
    callId: data?.callId,
    name: data?.name ?? 'tool',
    args: data?.arguments ?? '',
    status: 'waiting',
    output: '',
    turn: data?.turn ?? 0,
    step: data?.step ?? 0,
  });
  state.byCall.set(data?.callId, item);
};

const applyToolResult = (state, data) => {
  const block = data?.message?.content?.[0];
  const callId = block?.toolCallId;
  const failed = block?.isError === true || data?.error !== undefined;
  const output = (Array.isArray(block?.content) ? block.content : [])
    .map((item) => (item?.type === 'text' ? item.text : `[${item?.type ?? 'block'}]`))
    .join('\n');
  const item = state.byCall.get(callId);
  if (item === undefined) {
    add(state, {
      kind: 'tool', callId, name: data?.error?.name ?? 'tool', args: '',
      status: failed ? 'fail' : 'ok', output,
      turn: data?.turn ?? 0, step: data?.step ?? 0,
    });
    return;
  }
  item.status = failed ? 'fail' : 'ok';
  item.output = output;
  if (item.name === 'tool' && data?.error?.name) item.name = data.error.name;
};

const applyTitle = (state, data) => {
  const title = typeof data === 'string' ? data : data?.title;
  state.title = typeof title === 'string' ? title : undefined;
};

const applyStatusEvent = (state, type, data) => {
  if (type === 'turn/end') {
    const kind = data?.reason?.kind ?? data?.reason;
    if (NORMAL_TURN_REASONS.has(kind)) return;
    // A cancelled/aborted turn gets NO promoting assistant/message — drop
    // the streaming tail here or it hangs (and pins the stop button on).
    if (kind === 'aborted' || kind === 'cancelled') {
      state.tail = null;
      add(state, { kind: 'status', text: '已停止', tone: 'info' });
      return;
    }
    add(state, { kind: 'status', text: `回合结束（${kind ?? '未知'}）`, tone: 'warn' });
  } else if (type === 'llm/retry' || type === 'llm/retry-started') {
    add(state, { kind: 'status', text: '模型请求重试中', tone: 'info' });
  } else if (type === 'assistant/attempt') {
    add(state, { kind: 'status', text: '一次尝试未产出回复', tone: 'info' });
  } else if (type.startsWith('compaction/')) {
    add(state, { kind: 'status', text: '上下文已压缩', tone: 'info' });
  } else {
    add(state, { kind: 'status', text: type, tone: 'info' });
  }
};

const applyEvent = (state, event) => {
  const type = event?.type;
  const data = event?.data ?? {};
  switch (type) {
    case 'user/message': applyUserMessage(state, data); break;
    case 'assistant/message': applyAssistantMessage(state, data); break;
    case 'tool/call': applyToolCall(state, data); break;
    case 'tool/result': applyToolResult(state, data); break;
    case 'deliverables/presented':
      add(state, {
        kind: 'creation',
        files: Array.isArray(data?.files) ? data.files : [],
      });
      break;
    case 'session/title': applyTitle(state, data); break;
    case 'system/message': case 'todo/write': case 'approval/asked':
    case 'approval/decided': case 'goal/change': case 'plan/mode': {
      add(state, { kind: 'system', label: type.split('/')[0], types: [type] });
      break;
    }
    case 'step/start': case 'step/end': case 'turn/start':
    case 'request/header': case 'request/context':
      break;
    default: applyStatusEvent(state, type, data);
  }
};

// ---- assistant-stream frames ----------------------------------------------

const ensureTail = (state, frame) => {
  if (state.tail !== null && state.tail.attemptId === frame.attemptId) return state.tail;
  state.tail = {
    turn: frame.turn ?? 0, step: frame.step ?? 0,
    attemptId: frame.attemptId,
    text: '', reasoning: '', tools: new Map(), streaming: false,
  };
  return state.tail;
};

const applyToolCallDelta = (tail, chunk) => {
  let tool = tail.tools.get(chunk.id);
  if (tool === undefined) {
    tool = { id: chunk.id, name: '', args: '' };
    tail.tools.set(chunk.id, tool);
  }
  if (chunk.name) tool.name = chunk.name;
  tool.args += chunk.argumentsDelta ?? '';
};

const applyChunk = (state, frame) => {
  const tail = ensureTail(state, frame);
  const chunk = frame.chunk ?? {};
  if (chunk.type === 'text-delta') {
    tail.text += chunk.text ?? '';
    tail.streaming = true;
  } else if (chunk.type === 'reasoning-delta') {
    tail.reasoning += chunk.text ?? '';
    state.streamed.add(keyFor(tail.turn, tail.step));
  } else if (chunk.type === 'tool-call-delta') {
    applyToolCallDelta(tail, chunk);
  }
};

const applyStreamFrame = (state, frame) => {
  if (frame?.type === 'start') {
    ensureTail(state, frame);
  } else if (frame?.type === 'chunk') {
    applyChunk(state, frame);
  } else if (frame?.type === 'end' && state.tail?.attemptId === frame?.attemptId) {
    state.tail.streaming = false; // terminal; the durable message promotes the text
  }
};

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

const applyRecord = (state, record) => {
  if (record?.type === 'snapshot') setSnapshot(state, record);
  else if (record?.type === 'event') applyEvent(state, record.event);
  else applyStreamFrame(state, record);
};

const setSnapshot = (state, snapshot) => {
  const fresh = makeState();
  fresh.title = state.title;
  for (const record of snapshot?.records ?? []) applyRecord(fresh, record);
  const active = snapshot?.assistantStream?.activeAttempt;
  if (active !== undefined) {
    ensureTail(fresh, {
      type: 'start', attemptId: active.attemptId,
      turn: active.turn, step: active.step,
    });
    for (const frame of active.stream ?? []) applyStreamFrame(fresh, frame);
  }
  Object.assign(state, fresh);
};

/** The fold: pure state + record application, no subscription machinery. */
export const createFold = () => {
  const state = makeState();
  return {
    state,
    applyRecord: (record) => applyRecord(state, record),
    applyStreamFrame: (frame) => applyStreamFrame(state, frame),
    setSnapshot: (snapshot) => setSnapshot(state, snapshot),
  };
};

/** The timeline the view subscribes to: fold + two-tier notifications
 * ('structure' = rebuild the list; 'tail' = touch the streaming row only). */
export function createTimeline() {
  const fold = createFold();
  let version = 0;
  let structure = true; // next notify is a full re-render
  let notifies = 0;
  let fired = 0;
  const listeners = new Set();

  const notify = () => {
    version += 1;
    notifies += 1;
    const kind = structure ? 'structure' : 'tail';
    structure = false;
    for (const listener of listeners) {
      fired += 1;
      listener(kind, version);
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener('structure', version);
      return () => listeners.delete(listener);
    },
    applyRecord: (record) => {
      fold.applyRecord(record);
      structure = true;
      notify();
    },
    applyStreamFrame: (frame) => {
      fold.applyStreamFrame(frame);
      notify();
    },
    setSnapshot: (snapshot) => {
      fold.setSnapshot(snapshot);
      structure = true;
      notify();
    },
    get items() { return fold.state.items; },
    get tail() { return fold.state.tail; },
    get meta() { return { title: fold.state.title }; },
    get running() { return fold.state.tail !== null; },
    get notifyDebug() { return { notifies, fired, listeners: listeners.size }; },
  };
}
