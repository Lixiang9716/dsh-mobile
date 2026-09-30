// dsh:logging-exempt (test file: no logging surface)
/**
 * timeline.test.js — the journal → display-items fold (web/js/timeline.js),
 * a pure state machine: every leg feeds real journal records / assistant-
 * stream frames (the session-projection@0 vocabulary) and asserts the
 * folded items. Normal paths + the real edges: interrupted turns, streamed
 * builders becoming named cards, cancelled turns dropping the tail,
 * snapshot (seed) rebuilds, and records with missing fields.
 */
import { describe, expect, it } from 'vitest';
import { createFold, createTimeline } from '../web/js/timeline.js';

const event = (type, data, seq = 1) => ({ type: 'event', event: { type, seq, time: 0, data } });
const stream = (frame) => frame;

describe('durable journal events', () => {
  it('user/message with source user folds to a user bubble with images', () => {
    const fold = createFold();
    fold.applyRecord(event('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '画出极光' }, { type: 'image', url: 'x.png' }],
    }));
    expect(fold.state.items).toEqual([
      { kind: 'user', text: '画出极光', images: [{ type: 'image', url: 'x.png' }] },
    ]);
  });

  it('user/message from an injected source folds to a context notice; non-text only says so', () => {
    const fold = createFold();
    fold.applyRecord(event('user/message', {
      source: { kind: 'system' },
      content: [{ type: 'text', text: '注入的上下文' }],
    }));
    fold.applyRecord(event('user/message', {
      source: { kind: 'tool' },
      content: [{ type: 'image', url: 'y.png' }],
    }));
    expect(fold.state.items).toEqual([
      { kind: 'notice', label: '上下文', text: '注入的上下文' },
      { kind: 'notice', label: '上下文', text: '(非文本上下文)' },
    ]);
  });

  it('user/message with no content at all (missing field) folds to an empty bubble', () => {
    const fold = createFold();
    fold.applyRecord(event('user/message', { source: { kind: 'user' } }));
    expect(fold.state.items[0]).toMatchObject({ kind: 'user', text: '' });
  });

  it('assistant/message folds reasoning + markdown; streamed reasoning is not duplicated', () => {
    const fold = createFold();
    fold.applyRecord(stream({ type: 'start', attemptId: 'a1', turn: 1, step: 1 }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', chunk: { type: 'reasoning-delta', text: '想一遍' } }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '回声' } }));
    fold.applyRecord(stream({ type: 'end', attemptId: 'a1' }));
    fold.applyRecord(event('assistant/message', {
      turn: 1, step: 1,
      message: { content: [{ type: 'reasoning', text: '想一遍' }, { type: 'text', text: '回声' }] },
    }));
    // the streamed tail promotes: reasoning row + assistant row, tail gone
    expect(fold.state.items).toEqual([
      { kind: 'reasoning', text: '想一遍', turn: 1, step: 1 },
      { kind: 'assistant', markdown: '回声', interrupted: false, turn: 1, step: 1 },
    ]);
    expect(fold.state.tail).toBe(null);
  });

  it('unstreamed reasoning rides in with the durable message', () => {
    const fold = createFold();
    fold.applyRecord(event('assistant/message', {
      turn: 2, step: 1,
      message: { content: [{ type: 'reasoning', text: '悄悄想' }, { type: 'text', text: '答' }] },
    }));
    expect(fold.state.items[0]).toEqual({ kind: 'reasoning', text: '悄悄想', turn: 2, step: 1 });
    expect(fold.state.items[1]).toMatchObject({ kind: 'assistant', markdown: '答' });
  });

  it('an interrupted assistant/message marks the item and fails its unanswered tool calls', () => {
    const fold = createFold();
    fold.applyRecord(event('assistant/message', {
      turn: 3, step: 1, interrupted: true,
      message: { content: [
        { type: 'text', text: '说到一半' },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"x":1}' },
        { type: 'tool-call', id: 'c2', name: 'read' },
      ] },
    }));
    fold.applyRecord(event('assistant/message', { // second interrupted message, c1 already known
      turn: 3, step: 2, interrupted: true,
      message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash' }] },
    }));
    const tools = fold.state.items.filter((i) => i.kind === 'tool');
    expect(tools).toHaveLength(2); // c2 new; c1 not duplicated
    // args normalizes to '' like every other path (a missing arguments
    // field must not leak undefined into the fold — the renderer's
    // `item.args !== ''` branch would render a ghost args row)
    expect(tools.find((t) => t.callId === 'c2')).toMatchObject({
      status: 'fail', output: '已中断', name: 'read', args: '',
    });
    expect(fold.state.items[0]).toMatchObject({ kind: 'assistant', interrupted: true, markdown: '说到一半' });
  });

  it('tool/call makes a waiting card; a streamed builder is named by the durable call', () => {
    const fold = createFold();
    fold.applyRecord(stream({ type: 'start', attemptId: 'a1', turn: 1, step: 1 }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', chunk: { type: 'tool-call-delta', id: 'c1', argumentsDelta: '{"co' } }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', chunk: { type: 'tool-call-delta', id: 'c1', name: 'bash', argumentsDelta: 'mmand":"ls"}' } }));
    fold.applyRecord(event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }));
    // the durable call lands a waiting card right away (byCall); the tail
    // keeps its streamed builder copy — promotion dedups via byCall
    expect(fold.state.items).toHaveLength(1);
    expect(fold.state.items[0]).toMatchObject({ kind: 'tool', callId: 'c1', name: 'bash', status: 'waiting' });
    expect(fold.state.tail.tools.get('c1')).toEqual({ id: 'c1', name: 'bash', args: '{"command":"ls"}' });
    fold.applyRecord(event('assistant/message', { turn: 1, step: 1, message: { content: [] } }));
    const toolsAfter = fold.state.items.filter((i) => i.kind === 'tool');
    expect(toolsAfter).toHaveLength(1); // promotion did NOT duplicate the card
    expect(toolsAfter[0]).toMatchObject({
      kind: 'tool', callId: 'c1', name: 'bash', args: '{"command":"ls"}', status: 'waiting',
    });
    expect(fold.state.items.at(-1)).toMatchObject({ kind: 'assistant' }); // the promoting row landed
  });

  it('tool/call on an unseen callId makes a waiting card directly', () => {
    const fold = createFold();
    fold.applyRecord(event('tool/call', { turn: 1, step: 1, callId: 'c9', name: 'grep', arguments: 'x' }));
    expect(fold.state.items[0]).toMatchObject({ kind: 'tool', callId: 'c9', name: 'grep', status: 'waiting' });
  });

  it('tool/result settles the card: text join, isError, error.name surfaces', () => {
    const fold = createFold();
    fold.applyRecord(event('tool/call', { callId: 'c1', name: 'tool' }));
    fold.applyRecord(event('tool/result', {
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true,
        content: [{ type: 'text', text: 'boom' }, { type: 'image', url: 'z' }] }] },
      error: { name: 'bash' },
    }));
    expect(fold.state.items[0]).toMatchObject({ kind: 'tool', callId: 'c1', name: 'bash', status: 'fail', output: 'boom\n[image]' });
  });

  it('tool/result without a prior call lands a card on its own (honest fallback)', () => {
    const fold = createFold();
    fold.applyRecord(event('tool/result', {
      message: { content: [{ type: 'tool-result', toolCallId: 'c-late', isError: false,
        content: [{ type: 'text', text: 'out' }] }] },
    }));
    expect(fold.state.items[0]).toMatchObject({ kind: 'tool', callId: 'c-late', status: 'ok', output: 'out' });
  });

  it('turn/end: normal reasons are silent; aborted/cancelled drop the tail with 已停止', () => {
    const fold = createFold();
    fold.applyRecord(stream({ type: 'start', attemptId: 'a1', turn: 1, step: 1 }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '流到一半' } }));
    fold.applyRecord(event('turn/end', { turn: 1, reason: { kind: 'stop' } }));
    expect(fold.state.items).toEqual([]); // silent — a normal stop never renders a row
    fold.applyRecord(stream({ type: 'start', attemptId: 'a2', turn: 2, step: 1 }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a2', chunk: { type: 'text-delta', text: '再流' } }));
    fold.applyRecord(event('turn/end', { turn: 2, reason: { kind: 'cancelled' } }));
    expect(fold.state.items).toEqual([{ kind: 'status', text: '已停止', tone: 'info' }]);
    expect(fold.state.tail).toBe(null); // a cancelled turn gets no promoting message: dropped HERE
  });

  it('turn/end abnormal reasons surface as warn rows naming the reason', () => {
    const fold = createFold();
    fold.applyRecord(event('turn/end', { turn: 1, reason: { kind: 'overflow' } }));
    fold.applyRecord(event('turn/end', { turn: 2 }));
    expect(fold.state.items).toEqual([
      { kind: 'status', text: '回合结束（overflow）', tone: 'warn' },
      { kind: 'status', text: '回合结束（未知）', tone: 'warn' },
    ]);
  });

  it('the status family folds to its honest rows', () => {
    const fold = createFold();
    fold.applyRecord(event('llm/retry', {}));
    fold.applyRecord(event('assistant/attempt', {}));
    fold.applyRecord(event('compaction/start', {}));
    fold.applyRecord(event('some/unknown', { ignored: true }));
    expect(fold.state.items.map((i) => i.text)).toEqual([
      '模型请求重试中', '一次尝试未产出回复', '上下文已压缩', 'some/unknown',
    ]);
  });

  it('the silent family leaves no rows: turn/start, step/*, request/header|context', () => {
    const fold = createFold();
    fold.applyRecord(event('turn/start', { turn: 1 }));
    fold.applyRecord(event('step/start', { turn: 1, step: 1 }));
    fold.applyRecord(event('step/end', { turn: 1, step: 1 }));
    fold.applyRecord(event('request/header', { whatever: true }));
    fold.applyRecord(event('request/context', { whatever: true }));
    expect(fold.state.items).toEqual([]);
  });

  it('the system family collapses into labeled groups', () => {
    const fold = createFold();
    fold.applyRecord(event('system/message', { text: 'hi' }));
    fold.applyRecord(event('todo/write', { items: [] }));
    fold.applyRecord(event('approval/asked', { id: 'a' }));
    expect(fold.state.items).toEqual([
      { kind: 'system', label: 'system', types: ['system/message'] },
      { kind: 'system', label: 'todo', types: ['todo/write'] },
      { kind: 'system', label: 'approval', types: ['approval/asked'] },
    ]);
  });

  it('deliverables/presented folds to a creation card (missing files -> [])', () => {
    const fold = createFold();
    fold.applyRecord(event('deliverables/presented', { files: [{ path: 'p', description: 'd' }] }));
    fold.applyRecord(event('deliverables/presented', {}));
    expect(fold.state.items).toEqual([
      { kind: 'creation', files: [{ path: 'p', description: 'd' }] },
      { kind: 'creation', files: [] },
    ]);
  });

  it('session/title accepts {title} and bare strings; non-strings leave it unset', () => {
    const fold = createFold();
    fold.applyRecord(event('session/title', { title: '极光' }));
    expect(fold.state.title).toBe('极光');
    fold.applyRecord(event('session/title', '回声'));
    expect(fold.state.title).toBe('回声');
    fold.applyRecord(event('session/title', { nope: 1 }));
    expect(fold.state.title).toBe(undefined);
  });
});

describe('assistant-stream frames (the live tail)', () => {
  it('one tail accumulates text + reasoning + tools across chunks; end freezes it', () => {
    const fold = createFold();
    fold.applyRecord(stream({ type: 'start', attemptId: 'a1', turn: 1, step: 1 }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '你' } }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '好' } }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', chunk: { type: 'reasoning-delta', text: '想' } }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', chunk: { type: 'tool-call-delta', id: 'c1', name: 'bash', argumentsDelta: 'ls' } }));
    expect(fold.state.tail).toMatchObject({ attemptId: 'a1', text: '你好', reasoning: '想', streaming: true });
    expect(fold.state.tail.tools.get('c1')).toEqual({ id: 'c1', name: 'bash', args: 'ls' });
    fold.applyRecord(stream({ type: 'end', attemptId: 'a1' }));
    expect(fold.state.tail.streaming).toBe(false);
    expect(fold.state.tail.text).toBe('你好'); // held for the durable message to promote
  });

  it('a new attemptId replaces the tail', () => {
    const fold = createFold();
    fold.applyRecord(stream({ type: 'start', attemptId: 'a1', turn: 1, step: 1 }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '旧' } }));
    fold.applyRecord(stream({ type: 'start', attemptId: 'a2', turn: 1, step: 2 }));
    expect(fold.state.tail).toMatchObject({ attemptId: 'a2', text: '' });
  });

  it('chunks with unknown types are ignored (tail still created)', () => {
    const fold = createFold();
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', turn: 1, step: 1, chunk: { type: 'usage', tokens: 3 } }));
    expect(fold.state.tail).toMatchObject({ attemptId: 'a1', text: '', reasoning: '' });
  });

  it('promotion only happens for the SAME (turn, step)', () => {
    const fold = createFold();
    fold.applyRecord(stream({ type: 'start', attemptId: 'a1', turn: 1, step: 1 }));
    fold.applyRecord(stream({ type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '挂着' } }));
    fold.applyRecord(event('assistant/message', { turn: 9, step: 9, message: { content: [{ type: 'text', text: '别的回合' }] } }));
    expect(fold.state.tail).not.toBe(null); // mismatched settle does not steal the tail
    expect(fold.state.items).toEqual([
      { kind: 'assistant', markdown: '别的回合', interrupted: false, turn: 9, step: 9 },
    ]);
  });
});

describe('snapshot (the seed replay)', () => {
  it('setSnapshot rebuilds from records, preserves the title, resumes the active attempt', () => {
    const fold = createFold();
    fold.applyRecord(event('session/title', { title: '极光' }));
    fold.applyRecord(event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '旧话' }] }));
    fold.setSnapshot({
      records: [
        event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '新话' }] }, 1),
        event('tool/call', { callId: 'c1', name: 'bash' }, 2),
      ],
      assistantStream: {
        activeAttempt: {
          attemptId: 'a1', turn: 1, step: 1,
          stream: [
            { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: '恢复中' } },
          ],
        },
      },
    });
    expect(fold.state.title).toBe('极光'); // preserved across the rebuild
    expect(fold.state.items).toEqual([
      { kind: 'user', text: '新话', images: [] },
      { kind: 'tool', callId: 'c1', name: 'bash', args: '', status: 'waiting', output: '', turn: 0, step: 0 },
    ]);
    expect(fold.state.tail).toMatchObject({ attemptId: 'a1', text: '恢复中' });
  });

  it('an empty snapshot resets to a blank thread (the seed-start reset)', () => {
    const fold = createFold();
    fold.applyRecord(event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '旧话' }] }));
    fold.setSnapshot({ records: [], assistantStream: { revision: 0 } });
    expect(fold.state.items).toEqual([]);
    expect(fold.state.tail).toBe(null);
  });

  it('records that are neither events nor stream frames are ignored, not thrown', () => {
    const fold = createFold();
    expect(() => fold.applyRecord({ type: 'mystery' })).not.toThrow();
    expect(fold.state.items).toEqual([]);
  });
});

describe('createTimeline: the two-tier notification machinery', () => {
  it('subscribes with an initial structure, then structure for records, tail for stream frames', () => {
    const timeline = createTimeline();
    const seen = [];
    const unsubscribe = timeline.subscribe((kind, version) => seen.push([kind, version]));
    expect(seen).toEqual([['structure', 0]]);
    timeline.applyRecord(event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }));
    timeline.applyStreamFrame({ type: 'start', attemptId: 'a1', turn: 1, step: 1 });
    timeline.applyStreamFrame({ type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 'x' } });
    timeline.setSnapshot({ records: [], assistantStream: { revision: 0 } });
    expect(seen.map(([kind]) => kind)).toEqual(['structure', 'structure', 'tail', 'tail', 'structure']);
    expect(timeline.notifyDebug).toMatchObject({ listeners: 1 });
    unsubscribe();
    timeline.applyRecord(event('session/title', { title: 't' }));
    // fired counts notify()-driven deliveries only (the initial subscribe
    // ping is direct); no notification reaches anyone after unsubscribe
    expect(timeline.notifyDebug.fired).toBe(seen.length - 1);
    expect(timeline.notifyDebug.notifies).toBe(seen.length); // notify() itself still ran
    expect(timeline.meta).toEqual({ title: 't' });
  });

  it('running tracks the live tail', () => {
    const timeline = createTimeline();
    expect(timeline.running).toBe(false);
    timeline.applyStreamFrame({ type: 'start', attemptId: 'a1', turn: 1, step: 1 });
    expect(timeline.running).toBe(true);
    timeline.applyRecord(event('turn/end', { turn: 1, reason: { kind: 'cancelled' } }));
    expect(timeline.running).toBe(false);
  });
});
