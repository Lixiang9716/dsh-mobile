import { describe, expect, it } from 'vitest';
import { translateRecord, translateSnapshot } from '../driver/adapter.js';
import { createFold } from '../shared/fold.js';

const ev = (type, data) => ({ type: 'event', event: { type, seq: 1, time: 0, data } });

const namesOf = (events) => events.map((e) => `${e.type}:${e.kind ?? e.phase ?? e.kind ?? ''}`);

describe('adapter: journal records → view events', () => {
  it('a user prompt settles as a user-message', () => {
    const events = translateRecord(ev('user/message', {
      content: [{ type: 'text', text: '画出极光' }], source: { kind: 'user' },
    }));
    expect(events).toEqual([
      expect.objectContaining({ type: 'session-settled', kind: 'user-message', text: '画出极光' }),
    ]);
  });

  it('an injected context rides as a status row, never a user bubble', () => {
    const events = translateRecord(ev('user/message', {
      content: [{ type: 'text', text: 'ctx' }], source: { kind: 'injected' },
    }));
    expect(events[0]).toMatchObject({ type: 'session-settled', kind: 'status' });
  });

  it('an interrupted assistant message also fails its unanswered tool calls', () => {
    const events = translateRecord(ev('assistant/message', {
      turn: 2, step: 1, interrupted: true,
      message: { content: [
        { type: 'text', text: 'partial' },
        { type: 'tool-call', id: 't9', name: 'bash', arguments: '{}' },
      ] },
    }));
    expect(namesOf(events)).toEqual([
      'session-settled:assistant-message', 'tool-card-phase:fail',
    ]);
    expect(events[1]).toMatchObject({ callId: 't9', name: 'bash', output: '已中断' });
  });

  it('tool/call and tool/result map to the waiting and ok phases', () => {
    const call = translateRecord(ev('tool/call', {
      callId: 'c1', name: 'bash', arguments: '{"command":"ls"}',
    }));
    expect(call[0]).toMatchObject({
      type: 'tool-card-phase', phase: 'waiting', name: 'bash', args: '{"command":"ls"}',
    });
    const result = translateRecord(ev('tool/result', {
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: false,
        content: [{ type: 'text', text: 'total 24' }] }] },
    }));
    expect(result[0]).toMatchObject({ type: 'tool-card-phase', phase: 'ok', output: 'total 24' });
  });

  it('a failed result maps to the fail phase', () => {
    const events = translateRecord(ev('tool/result', {
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true,
        content: [{ type: 'text', text: 'boom' }] }] },
    }));
    expect(events[0].phase).toBe('fail');
  });

  it('title, creation, turn-end and the system family keep their shapes', () => {
    expect(translateRecord(ev('session/title', { title: 'dev 会话' }))[0])
      .toMatchObject({ kind: 'title', title: 'dev 会话' });
    expect(translateRecord(ev('deliverables/presented', {
      files: [{ path: 'creations/x.html', description: 'd' }],
    }))[0]).toMatchObject({ kind: 'creation', files: [{ path: 'creations/x.html' }] });
    expect(translateRecord(ev('turn/end', { reason: { kind: 'cancelled' } }))[0])
      .toMatchObject({ kind: 'turn-end', reason: 'cancelled' });
    expect(translateRecord(ev('goal/change', { note: 1 }))[0])
      .toMatchObject({ kind: 'system', label: 'goal', source: 'goal/change' });
  });

  it('bookkeeping events translate to NOTHING (no render noise)', () => {
    for (const type of ['turn/start', 'step/start', 'step/end',
      'request/header', 'request/context']) {
      expect(translateRecord(ev(type, {}))).toEqual([]);
    }
  });

  it('assistant-stream frames map to deltas and building cards', () => {
    expect(translateRecord({ type: 'start', attemptId: 'a1', turn: 1, step: 1 })[0])
      .toMatchObject({ type: 'message-delta', kind: 'start' });
    expect(translateRecord({
      type: 'chunk', attemptId: 'a1', chunk: { type: 'reasoning-delta', text: 'r' },
    })[0]).toMatchObject({ type: 'message-delta', kind: 'reasoning', text: 'r' });
    expect(translateRecord({
      type: 'chunk', attemptId: 'a1', chunk: {
        type: 'tool-call-delta', id: 'c1', name: 'bash', argumentsDelta: '{"x',
      },
    })[0]).toMatchObject({
      type: 'tool-card-phase', phase: 'streaming', callId: 'c1', argsDelta: '{"x',
    });
    expect(translateRecord({ type: 'end', attemptId: 'a1' })[0].kind).toBe('end');
  });
});

describe('adapter: the snapshot seed burst', () => {
  it('brackets the whole history with seed-start / seed-end', () => {
    const snapshot = {
      records: [
        ev('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
        ev('assistant/message', {
          turn: 1, step: 1, message: { content: [{ type: 'text', text: 'yo' }] },
        }),
      ],
      assistantStream: { revision: 0 },
    };
    const events = translateSnapshot(snapshot);
    expect(events[0]).toMatchObject({ type: 'session-settled', kind: 'seed-start' });
    expect(events.at(-1)).toMatchObject({ type: 'session-settled', kind: 'seed-end' });
    // The folded burst rebuilds the thread: user bubble + assistant answer.
    const fold = createFold();
    events.forEach((event) => fold.apply(event));
    expect(fold.state.items.map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect(fold.state.seedComplete).toBe(true);
  });

  it('replays a live attempt from assistantStream.activeAttempt', () => {
    const snapshot = {
      records: [],
      assistantStream: {
        revision: 1,
        activeAttempt: {
          attemptId: 'a1', turn: 2, step: 1,
          stream: [
            { type: 'start', attemptId: 'a1', turn: 2, step: 1 },
            { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 'live' } },
          ],
        },
      },
    };
    const fold = createFold();
    translateSnapshot(snapshot).forEach((event) => fold.apply(event));
    expect(fold.state.tail).toMatchObject({ attemptId: 'a1', text: 'live' });
  });
});
