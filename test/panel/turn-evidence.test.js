import { describe, expect, it } from 'vitest';

// T-0210 (2026-10-10 final-sweep burst): alpha/beta's SECOND turns completed
// — the spine journal holds the account — but their `write.turn.settled`
// records appear NOWHERE (not in hilog, not in the truncation-proof capture
// D:/tmp-android/final-sweep/). The emit chain is lossless (logger.info →
// __DSH_LOG_SINK__ → the host sink: synchronous, no queue), so the line was
// never emitted: the turn accumulator latched `settled` per SESSION forever
// and deterministically skipped every later turn/end. Concurrency was never
// the mechanism — the burst was merely the first drive to run a second turn
// on pre-existing sessions (the fresh gamma/delta sessions settled fine).
//
// This suite pins web-live/turn-evidence.js: the accumulator with the RE-ARM
// (a prompt on a settled record opens a fresh page), driven through the
// exact shapes the incident produced — plus the single-turn byte-identity
// the e2e manifests pin (write.turn.settled events:11, prompt seq:5).

const { makeTurnEvidence } = await import('../../runtime/dsh/web-live/turn-evidence.js');
const { turnFailureOf } = await import('../../runtime/dsh/web-live/turn-failure.js');
const { describeLlmRetry } = await import('../../runtime/dsh/upstream/retry-telemetry.js');

const EXPECTED_TEXT = 'Hello from upstream';

/** A recording emit: the canonical records land here in call order. */
const recorder = () => {
  const records = [];
  return {
    records,
    emit: (event, fields = {}) => records.push({ event, ...fields }),
    of: (event) => records.filter((r) => r.event === event),
  };
};

/** A handler wired like the composer seats wire theirs (scripted assert on). */
const wired = (rec) => makeTurnEvidence({
  emit: rec.emit,
  demand: (cond, reason) => { if (!cond) throw new Error(reason); },
  expectedText: EXPECTED_TEXT,
  describeRetry: describeLlmRetry,
  failureOf: turnFailureOf,
});

/** A handler wired for a REAL endpoint's route: the text is nondeterministic
 * and is reported verbatim — `demand: null`, exactly what the seats pass
 * when `route.scripted` is false. The burst and the failure-fold shapes are
 * real-route faces (the final-sweep burst answered through byok). */
const unwired = (rec) => makeTurnEvidence({
  emit: rec.emit,
  demand: null,
  expectedText: EXPECTED_TEXT,
  describeRetry: describeLlmRetry,
  failureOf: turnFailureOf,
});

const session = (id) => ({ id });

/** The journal event shapes the settle projection reads. */
const userMessage = (seq) => ({ type: 'user/message', seq });
const assistantMessage = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const turnEnd = (reason = { kind: 'completed' }) => ({ type: 'turn/end', data: { reason } });
const llmRetry = (retry, code) => ({ type: 'llm/retry', data: { retry, failure: { code, message: `wire failed (${code})` } } });

/** The assistant-text fold the pre-fix shape shares with the module. */
const assistantTextOf = (event) => (event?.data?.message?.content ?? [])
  .filter((block) => block?.type === 'text').map((block) => block.text).join('');

/** One scripted turn's journal window for `id`: 4 pre-prompt lines (seqs
 * 1-4 on turn 1 — the window the FIRST record opens at, which is what pins
 * settle events:11), the prompt at seqBase+4 (seq 5), the reply, 4 more
 * journal lines, then turn/end — 11 events, the exact record the e2e
 * manifest pins. On a LATER turn the 4 pre-prompt lines absorb into the
 * still-open settled record (never surfaced); the fresh window counts from
 * the prompt: 7 events. */
const scriptedTurn = (h, id, seqBase, text = EXPECTED_TEXT) => {
  for (let seq = seqBase; seq < seqBase + 4; seq++) h(session(id), { type: 'session/created', seq });
  h(session(id), userMessage(seqBase + 4));
  h(session(id), assistantMessage(text));
  for (let seq = seqBase + 6; seq < seqBase + 10; seq++) h(session(id), { type: 'session/preset-joined', seq });
  h(session(id), turnEnd());
};

/** The burst round, maximally interleaved: every t2 turn OPEN at once —
 * journal line, prompt, ack, reply per session crossing, then the ends in
 * mixed order. One serial queue delivers them in exactly this call order. */
const driveOpenBurst = (h, ids) => {
  for (const id of ids) h(session(id), { type: 'session/preset-joined', seq: 11 });
  for (const id of ids) h(session(id), userMessage(12));
  for (const id of ids) h(session(id), { type: 'session/control-ack', seq: 13 });
  for (const id of ids) h(session(id), assistantMessage(`burst ${id} ok.`));
  for (const id of ['s-p1-delta', 's-p1-alpha', 's-p1-beta', 's-p1-gamma']) h(session(id), turnEnd());
};

describe('T-0210: the burst model — 4 sessions × 2 turns, every settle arrives', () => {
  it('a session\'s SECOND turn settles — the latched-guard face, now re-armed', () => {
    const rec = recorder();
    const h = wired(rec);
    scriptedTurn(h, 's-alpha', 1);
    expect(rec.of('write.turn.settled')).toHaveLength(1);
    // The second turn (the burst round): its own prompt, its own settle.
    scriptedTurn(h, 's-alpha', 12);
    expect(rec.of('write.turn.settled')).toEqual([
      {
        event: 'write.turn.settled', sessionId: 's-alpha', events: 11, text: EXPECTED_TEXT,
      },
      {
        event: 'write.turn.settled', sessionId: 's-alpha',
        events: 7, text: EXPECTED_TEXT, // the second window: prompt → end
      },
    ]);
    // Every turn's prompt is observed — the old shape latched `prompt` too.
    expect(rec.of('write.prompt.observed').map((r) => r.seq)).toEqual([5, 16]);
  });

  it('the measured burst: 4 sessions, t1s settle, then 4 open t2s cross — all 8 records land', () => {
    const rec = recorder();
    const h = unwired(rec); // the burst ran a real endpoint: verbatim text, no assert
    const ids = ['s-p1-alpha', 's-p1-beta', 's-p1-gamma', 's-p1-delta'];
    for (const id of ids) scriptedTurn(h, id, 1);
    expect(rec.of('write.turn.settled')).toHaveLength(4);
    driveOpenBurst(h, ids);
    const settles = rec.of('write.turn.settled');
    expect(settles).toHaveLength(8);
    expect(settles.slice(4).map((r) => r.sessionId)).toEqual(
      ['s-p1-delta', 's-p1-alpha', 's-p1-beta', 's-p1-gamma']);
    for (const settle of settles.slice(4)) {
      expect(settle.events).toBe(4); // prompt + ack + reply + end per window
      expect(settle.text).toBe(`burst ${settle.sessionId} ok.`);
    }
    expect(rec.of('write.prompt.observed')).toHaveLength(8);
    expect(rec.of('write.prompt.observed').slice(4).every((r) => r.seq === 12)).toBe(true);
  });

  it('a third turn settles too — the re-arm is not a two-record latch (the android nextSettled face)', () => {
    const rec = recorder();
    const h = wired(rec);
    scriptedTurn(h, 's-x', 1);
    scriptedTurn(h, 's-x', 12);
    scriptedTurn(h, 's-x', 23);
    expect(rec.of('write.turn.settled')).toHaveLength(3);
    expect(rec.of('write.prompt.observed')).toHaveLength(3);
  });
});

describe('T-0210: the pre-fix shape, reproduced — the per-session latch loses every later turn', () => {
  // The OLD accumulator, verbatim (composer-web-live installTurnEvidence
  // before this fix): the record opens once per session and never re-arms.
  it('the latched shape: a second turn settles NOTHING (the incident, pinned)', () => {
    const rec = recorder();
    const turns = new Map();
    const oldHandler = (sess, event) => {
      if (sess?.id === undefined || event === undefined) return;
      let turn = turns.get(sess.id);
      if (turn === undefined) {
        turn = { prompt: false, events: 0, text: '', settled: false };
        turns.set(sess.id, turn);
      }
      turn.events++;
      if (event.type === 'user/message' && !turn.prompt) {
        turn.prompt = true;
        rec.emit('write.prompt.observed', { sessionId: sess.id, seq: event.seq });
      }
      if (event.type === 'assistant/message') turn.text = assistantTextOf(event);
      if (event.type === 'turn/end' && !turn.settled) {
        turn.settled = true;
        rec.emit('write.turn.settled', { sessionId: sess.id, events: turn.events, text: turn.text });
      }
    };
    scriptedTurn(oldHandler, 's-alpha', 1);
    scriptedTurn(oldHandler, 's-alpha', 12); // the burst round — completed, journal has the account
    expect(rec.of('write.turn.settled')).toHaveLength(1); // ← the defect face
    expect(rec.of('write.prompt.observed')).toHaveLength(1);
  });
});

describe('T-0210: the pinned single-turn record stays byte-identical', () => {
  it('one turn: settle events:11, prompt seq:5, no error key — the manifest shape', () => {
    const rec = recorder();
    const h = wired(rec);
    scriptedTurn(h, 's-b4-ondevice-0001', 1);
    expect(rec.of('write.prompt.observed')).toEqual([
      { event: 'write.prompt.observed', sessionId: 's-b4-ondevice-0001', seq: 5 },
    ]);
    expect(rec.of('write.turn.settled')).toEqual([
      { event: 'write.turn.settled', sessionId: 's-b4-ondevice-0001', events: 11, text: EXPECTED_TEXT },
    ]);
  });

  it('a completed turn reports the LAST assistant text before the end', () => {
    const rec = recorder();
    const h = wired(rec);
    h(session('s-a'), userMessage(1));
    h(session('s-a'), assistantMessage('draft…'));
    h(session('s-a'), assistantMessage(EXPECTED_TEXT));
    h(session('s-a'), turnEnd());
    expect(rec.of('write.turn.settled')[0].text).toBe(EXPECTED_TEXT);
  });
});

describe('T-0210: the failure fold rides every turn', () => {
  it('an errored turn folds {kind, code, message, lastRetry} — and the NEXT turn still settles', () => {
    const rec = recorder();
    const h = unwired(rec); // the incident (session-4331764d) was a real route
    h(session('s-a'), userMessage(1));
    h(session('s-a'), llmRetry(1, 'TRANSPORT'));
    h(session('s-a'), turnEnd({ kind: 'aborted', reason: { kind: 'watchdog', message: 'no turn progress for 300000ms' } }));
    expect(rec.of('write.turn.settled')[0]).toEqual({
      event: 'write.turn.settled', sessionId: 's-a', events: 3, text: '',
      error: {
        kind: 'aborted', code: 'watchdog', message: 'no turn progress for 300000ms',
        lastRetry: 'attempt 1: TRANSPORT wire failed (TRANSPORT)',
      },
    });
    // Re-arm across a failure: the session's next turn is reported too.
    scriptedTurn(h, 's-a', 4);
    const settles = rec.of('write.turn.settled');
    expect(settles).toHaveLength(2);
    expect(settles[1].error).toBeUndefined();
  });

  it('demand: null (a real endpoint / creation mode) reports verbatim text, never asserts', () => {
    const rec = recorder();
    const h = makeTurnEvidence({
      emit: rec.emit, demand: null, expectedText: EXPECTED_TEXT,
      describeRetry: describeLlmRetry, failureOf: turnFailureOf,
    });
    scriptedTurn(h, 's-a', 1, 'a real model said something else');
    expect(rec.of('write.turn.settled')[0].text).toBe('a real model said something else');
  });
});

describe('T-0210: the scripted demand and the duplicate end keep their latch semantics', () => {
  it('the scripted text demand still fails loud on a wrong reply (before any settle)', () => {
    const rec = recorder();
    const h = wired(rec);
    h(session('s-a'), userMessage(1));
    h(session('s-a'), assistantMessage('drifted text'));
    expect(() => h(session('s-a'), turnEnd())).toThrow('assistant text is "drifted text"');
    expect(rec.of('write.turn.settled')).toHaveLength(0);
  });

  it('a duplicate turn/end inside one turn settles once — a settle leaves the record latched-open', () => {
    const rec = recorder();
    const h = wired(rec);
    scriptedTurn(h, 's-a', 1);
    h(session('s-a'), turnEnd());
    h(session('s-a'), turnEnd());
    expect(rec.of('write.turn.settled')).toHaveLength(1);
  });

  it('events for an unknown session or undefined event are ignored (the boot guard)', () => {
    const rec = recorder();
    const h = wired(rec);
    h(undefined, turnEnd());
    h(session('s-a'), undefined);
    expect(rec.records).toHaveLength(0);
  });
});
