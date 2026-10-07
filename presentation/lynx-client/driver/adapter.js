// dsh:logging-exempt (pure data machinery: no I/O — the driver boundary owns logging)
/**
 * adapter.js — the ONE domain→view translator (event-model iron law #1:
 * the driver's follow feed is the single subscription point; nothing
 * downstream ever sees a domain record or a raw stream frame).
 *
 * translateRecord maps one session/follow item to zero or more view
 * events; translateSnapshot maps the whole seed snapshot (records +
 * live assistantStream) to the cold-start burst, bracketed by
 * seed-start / seed-end so a mid-session mount rebuilds instead of
 * starting blank.
 *
 * The mapping table is the journal vocabulary web-client-v2 renders
 * (timeline.js's switch, unmoved): user/message, assistant/message,
 * tool/call, tool/result, deliverables/presented, session/title,
 * turn/end, the status family, the system family — and the assistant
 * stream frames start/chunk/end.
 */

import {
  makeDelta, makeToolPhase, makeSettled,
} from '../shared/view-events.js';

const textOf = (blocks, type) => (Array.isArray(blocks) ? blocks : [])
  .filter((block) => block?.type === type)
  .map((block) => block.text)
  .join('');

const SILENT_EVENT_TYPES = new Set(['request/header', 'request/context']);

// ---- durable journal records ----------------------------------------------

const translateUserMessage = (data) => {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = textOf(blocks, 'text');
  if (data?.source?.kind !== 'user') {
    return [makeSettled('status', { text: `上下文：${text || '(非文本上下文)'}`, tone: 'info' })];
  }
  return [makeSettled('user-message', {
    text,
    images: blocks.filter((block) => block?.type === 'image'),
  })];
};

const translateAssistantMessage = (data) => {
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
  const turn = data?.turn ?? 0;
  const step = data?.step ?? 0;
  const events = [makeSettled('assistant-message', {
    turn, step,
    markdown: textOf(blocks, 'text'),
    reasoning: textOf(blocks, 'reasoning'),
    interrupted: data?.interrupted === true,
  })];
  // An interrupted turn's unanswered tool calls settle as failed cards
  // (timeline.js's recordInterruptedCalls, promoted into the adapter).
  if (data?.interrupted === true) {
    for (const block of blocks) {
      if (block?.type !== 'tool-call') continue;
      events.push(makeToolPhase('fail', {
        callId: block.id, name: block.name ?? 'tool',
        args: typeof block.arguments === 'string' ? block.arguments : '',
        output: '已中断',
      }));
    }
  }
  return events;
};

const translateToolCall = (data) => [makeToolPhase('waiting', {
  callId: data?.callId,
  name: data?.name ?? 'tool',
  args: typeof data?.arguments === 'string' ? data.arguments : '',
})];

const translateToolResult = (data) => {
  const block = data?.message?.content?.[0];
  const callId = block?.toolCallId;
  const failed = block?.isError === true || data?.error !== undefined;
  const output = (Array.isArray(block?.content) ? block.content : [])
    .map((item) => (item?.type === 'text' ? item.text : `[${item?.type ?? 'block'}]`))
    .join('\n');
  return [makeToolPhase(failed ? 'fail' : 'ok', { callId, output })];
};

const translateTurnEnd = (data) => {
  const reason = data?.reason?.kind ?? data?.reason ?? 'unknown';
  return [makeSettled('turn-end', { reason: String(reason) })];
};

const translateStatus = (type, data) => {
  if (type === 'llm/retry' || type === 'llm/retry-started') {
    return [makeSettled('status', { text: '模型请求重试中', tone: 'info' })];
  }
  if (type === 'assistant/attempt') {
    return [makeSettled('status', { text: '一次尝试未产出回复', tone: 'info' })];
  }
  if (type.startsWith('compaction/')) {
    return [makeSettled('status', { text: '上下文已压缩', tone: 'info' })];
  }
  void data;
  return [makeSettled('status', { text: type, tone: 'info' })];
};

const translateEvent = (event) => {
  const type = event?.type;
  const data = event?.data ?? {};
  switch (type) {
    case 'user/message': return translateUserMessage(data);
    case 'assistant/message': return translateAssistantMessage(data);
    case 'tool/call': return translateToolCall(data);
    case 'tool/result': return translateToolResult(data);
    case 'deliverables/presented':
      return [makeSettled('creation', {
        files: Array.isArray(data?.files) ? data.files : [],
      })];
    case 'session/title': {
      const title = typeof data === 'string' ? data : data?.title;
      return [makeSettled('title', {
        title: typeof title === 'string' ? title : undefined,
      })];
    }
    case 'turn/end': return translateTurnEnd(data);
    case 'system/message': case 'todo/write': case 'approval/asked':
    case 'approval/decided': case 'goal/change': case 'plan/mode':
      return [makeSettled('system', { label: type.split('/')[0], source: type })];
    case 'turn/start': case 'step/start': case 'step/end':
    case 'request/header': case 'request/context':
      return [];
    default: return translateStatus(type, data);
  }
};

// ---- assistant-stream frames ----------------------------------------------

const translateStreamFrame = (frame) => {
  if (frame?.type === 'start') {
    return [makeDelta('start', {
      attemptId: frame.attemptId, turn: frame.turn ?? 0, step: frame.step ?? 0,
    })];
  }
  if (frame?.type === 'end') {
    return [makeDelta('end', {
      attemptId: frame.attemptId, turn: frame.turn ?? 0, step: frame.step ?? 0,
    })];
  }
  if (frame?.type !== 'chunk') return [];
  const chunk = frame.chunk ?? {};
  if (chunk.type === 'text-delta') {
    return [makeDelta('text', {
      attemptId: frame.attemptId, turn: frame.turn ?? 0, step: frame.step ?? 0,
      text: chunk.text ?? '',
    })];
  }
  if (chunk.type === 'reasoning-delta') {
    return [makeDelta('reasoning', {
      attemptId: frame.attemptId, turn: frame.turn ?? 0, step: frame.step ?? 0,
      text: chunk.text ?? '',
    })];
  }
  if (chunk.type === 'tool-call-delta') {
    return [makeToolPhase('streaming', {
      callId: chunk.id, name: chunk.name, argsDelta: chunk.argumentsDelta ?? '',
    })];
  }
  return [];
};

// ---- the two entries --------------------------------------------------------

/** One follow-feed item (durable `{type:'event'}` or a stream frame) →
 * view events. */
export const translateRecord = (record) => {
  if (record?.type === 'event') return translateEvent(record.event);
  if (record?.type === 'snapshot') return translateSnapshotPayload(record);
  return translateStreamFrame(record);
};

const translateSnapshotPayload = (snapshot) => {
  const events = [makeSettled('seed-start', {})];
  for (const record of snapshot?.records ?? []) {
    events.push(...(record?.type === 'event'
      ? translateEvent(record.event)
      : translateStreamFrame(record)));
  }
  const active = snapshot?.assistantStream?.activeAttempt;
  if (active !== undefined) {
    events.push(...translateStreamFrame({
      type: 'start', attemptId: active.attemptId,
      turn: active.turn, step: active.step,
    }));
    for (const frame of active.stream ?? []) events.push(...translateStreamFrame(frame));
  }
  events.push(makeSettled('seed-end', {}));
  return events;
};

/** A whole follow snapshot → the cold-start seed burst of view events. */
export const translateSnapshot = (snapshot) => translateSnapshotPayload(snapshot ?? {});
