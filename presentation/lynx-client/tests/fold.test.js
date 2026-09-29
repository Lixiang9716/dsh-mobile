import { describe, expect, it } from 'vitest';
import { applyViewEvent, createFold, isRunning, makeFoldState, snapshotState }
  from '../shared/fold.js';
import { makeDelta, makeSettled, makeToolPhase } from '../shared/view-events.js';

const feed = (fold, events) => events.forEach((event) => fold.apply(event));

const startTail = (fold) => feed(fold, [
  makeDelta('start', { attemptId: 'a1', turn: 1, step: 1 }),
]);

describe('fold: streaming tail', () => {
  it('accumulates text and reasoning; the end marks the tail terminal', () => {
    const fold = createFold();
    startTail(fold);
    feed(fold, [
      makeDelta('reasoning', { attemptId: 'a1', turn: 1, step: 1, text: 'think' }),
      makeDelta('text', { attemptId: 'a1', turn: 1, step: 1, text: 'say' }),
    ]);
    expect(fold.state.tail).toMatchObject({ text: 'say', reasoning: 'think', streaming: true });
    expect(isRunning(fold.state)).toBe(true);
    fold.apply(makeDelta('end', { attemptId: 'a1', turn: 1, step: 1 }));
    expect(fold.state.tail.streaming).toBe(false);
  });

  it('the durable assistant message promotes the tail of its turn:step', () => {
    const fold = createFold();
    startTail(fold);
    feed(fold, [
      makeDelta('text', { attemptId: 'a1', turn: 1, step: 1, text: 'final words' }),
      makeDelta('reasoning', { attemptId: 'a1', turn: 1, step: 1, text: 'r' }),
      makeSettled('assistant-message', {
        turn: 1, step: 1, markdown: 'final words', reasoning: 'r', interrupted: false,
      }),
    ]);
    expect(fold.state.tail).toBeNull();
    expect(fold.state.items.map((i) => i.kind)).toEqual(['reasoning', 'assistant']);
  });

  it('a reasoning stream suppresses the duplicated durable reasoning row', () => {
    const fold = createFold();
    startTail(fold);
    feed(fold, [
      makeDelta('reasoning', { attemptId: 'a1', turn: 1, step: 1, text: 'r' }),
      makeSettled('assistant-message', {
        turn: 1, step: 1, markdown: 'm', reasoning: 'r', interrupted: false,
      }),
    ]);
    expect(fold.state.items.filter((i) => i.kind === 'reasoning').length).toBe(1);
  });
});

describe('fold: tool cards', () => {
  it('a streamed builder becomes the pending card the durable call names', () => {
    const fold = createFold();
    startTail(fold);
    feed(fold, [
      makeToolPhase('streaming', { callId: 'c1', name: 'bash', argsDelta: '{"c' }),
      makeToolPhase('waiting', { callId: 'c1', name: 'bash', args: '{"command":"ls"}' }),
      makeToolPhase('ok', { callId: 'c1', output: 'total 24' }),
    ]);
    const card = fold.state.byCall.get('c1');
    expect(card).toMatchObject({ name: 'bash', status: 'ok', output: 'total 24' });
  });

  it('an unseen call lands its card straight at the result phase', () => {
    const fold = createFold();
    fold.apply(makeToolPhase('fail', { callId: 'cx', name: 'wasm', output: 'boom' }));
    expect(fold.state.items[0]).toMatchObject({ kind: 'tool', status: 'fail', output: 'boom' });
  });
});

describe('fold: settled facts', () => {
  it('a cancelled turn drops the tail and records 已停止; a normal stop is silent', () => {
    const fold = createFold();
    startTail(fold);
    fold.apply(makeSettled('turn-end', { reason: 'cancelled' }));
    expect(fold.state.tail).toBeNull();
    expect(fold.state.items.at(-1)).toMatchObject({ kind: 'status', text: '已停止' });

    const quiet = createFold();
    startTail(quiet);
    quiet.apply(makeSettled('turn-end', { reason: 'stop' }));
    expect(quiet.state.items).toEqual([]);
  });

  it('prompt-admitted runs optimistically until a stream frame or turn end', () => {
    const fold = createFold();
    fold.apply(makeSettled('prompt-admitted', {}));
    expect(isRunning(fold.state)).toBe(true);
    startTail(fold);
    // The live signal retires the optimism — the turn stays running, now
    // owned by the tail instead of the optimistic flag. (A 'stop' turn-end
    // leaves the tail terminal-but-present until its durable message lands;
    // the retirement to not-running is asserted on the cancelled end, which
    // drops the tail outright.)
    expect(fold.state.pendingPrompt).toBe(false);
    expect(isRunning(fold.state)).toBe(true);
    fold.apply(makeSettled('turn-end', { reason: 'cancelled' }));
    expect(fold.state.pendingPrompt).toBe(false);
    expect(isRunning(fold.state)).toBe(false);
  });

  it('seed-start resets the thread but keeps the shell (connection, drawer)', () => {
    const fold = createFold();
    fold.apply(makeSettled('connection', { status: 'open' }));
    fold.apply(makeSettled('sessions', { items: [{ sessionId: 's1' }] }));
    fold.apply(makeSettled('user-message', { text: 'old' }));
    fold.apply(makeSettled('seed-start', {}));
    expect(fold.state.items).toEqual([]);
    expect(fold.state.connection).toBe('open');
    expect(fold.state.sessions).toEqual([{ sessionId: 's1' }]);
    expect(fold.state.seedComplete).toBe(false);
    fold.apply(makeSettled('seed-end', {}));
    expect(fold.state.seedComplete).toBe(true);
  });
});

describe('fold: snapshot publication', () => {
  it('snapshotState is plain data with arrays instead of Maps', () => {
    const state = makeFoldState();
    state.tail = { turn: 1, step: 1, attemptId: 'a', text: 't', reasoning: 'r',
      streaming: true, tools: new Map([['c1', { id: 'c1', name: 'bash', args: '' }]]) };
    const snap = snapshotState(state);
    expect(() => JSON.stringify(snap)).not.toThrow();
    expect(snap.tail.tools).toEqual([{ id: 'c1', name: 'bash', args: '' }]);
    expect(snap.items).toEqual([]);
  });

  it('applyViewEvent rejects anything outside the closed set', () => {
    expect(() => applyViewEvent(makeFoldState(), { type: 'alien' })).toThrow(/type/);
  });
});
