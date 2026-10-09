// dsh:logging-exempt (pure accumulator; emission rides the caller's emit)
/**
 * web-live/turn-evidence.js — the settle projection's turn accumulator,
 * extracted from composer-web-live / harmony-composer-live-write
 * installTurnEvidence (the T-0210 BE-track fix).
 *
 * The measured defect (2026-10-10 final-sweep burst: 4 concurrent sessions,
 * alpha/beta on their SECOND turn): both turns completed — the spine journal
 * holds the account — yet their `write.turn.settled` records appear NOWHERE,
 * not in hilog and not in the truncation-proof capture. The emit chain is
 * lossless (the logger's info → `__DSH_LOG_SINK__` → the host sink are all
 * synchronous calls with no queue), so the line was never EMITTED: the
 * accumulator latched `settled` (and `prompt`) per SESSION forever, and a
 * latched guard deterministically skipped every later `turn/end`. High
 * concurrency was never the mechanism — any second turn on any session was
 * silent; the burst was merely the first drive to run one.
 *
 * The fix is the RE-ARM: a `user/message` on a settled record opens a FRESH
 * page — every turn prompts, accumulates, and settles on its own. The
 * re-arm rides the PROMPT (the turn boundary), not the settle: a settle
 * leaves its record latched-open, so a duplicate `turn/end` for the same
 * turn still settles once and never lands on a virgin page (the old latch's
 * one safe property, kept). The per-record `events` window keeps the pinned
 * first-turn record byte-identical — the FIRST record opens at the session's
 * first event (pre-prompt journal lines count, events:11 stays events:11) —
 * while every LATER turn's settle counts its own window, from its prompt
 * through its end.
 */

/** The assistant text of one assistant/message event (upstream message shape:
 * data.message.content blocks; text blocks joined). */
const assistantTextOf = (event) => (event?.data?.message?.content ?? [])
  .filter((block) => block?.type === 'text').map((block) => block.text).join('');

/**
 * Build the `session/event` handler the composer seats install for turn
 * evidence.
 *
 * @param {Function} emit - the scenario's canonical record emitter
 *   (`(event, fields) => log.info('e2e', {...})`).
 * @param {Function|null} demand - the fail-loud text assert, or `null` when
 *   the route's text is not assertable (a real endpoint's turn reports
 *   verbatim; creation mode's extra turns are deliberately not the scripted
 *   reply). When non-null, `turn.text === expectedText` is demanded at every
 *   settle — on the scripted loopback every turn answers the same text, so
 *   the per-turn assert holds.
 * @param {string} expectedText - the scripted stream's success text.
 * @param {Function} describeRetry - one-lines an `llm/retry` journal event.
 * @param {Function} failureOf - folds a `turn/end` reason + the turn's last
 *   retry into the settle record's structured `error` (null when completed).
 * @returns {(session, event) => void} the `ctx.on('session/event')` handler.
 */
export const makeTurnEvidence = ({ emit, demand, expectedText, describeRetry, failureOf }) => {
  const turns = new Map(); // sessionId → the session's OPEN turn record
  const freshTurn = () => ({ prompt: false, events: 0, text: '', settled: false, lastRetry: undefined });
  return (session, event) => {
    if (session?.id === undefined || event === undefined) return;
    if (event.type === 'user/message' && turns.get(session.id)?.settled) {
      // The re-arm (this fix): the previous page settled, so this prompt is
      // a NEW turn. The old shape left the settled record in place, and its
      // latched flags silently swallowed everything this turn did.
      turns.set(session.id, freshTurn());
    }
    let turn = turns.get(session.id);
    if (turn === undefined) {
      turn = freshTurn();
      turns.set(session.id, turn);
    }
    turn.events++;
    if (event.type === 'user/message' && !turn.prompt) {
      turn.prompt = true;
      emit('write.prompt.observed', { sessionId: session.id, seq: event.seq });
    }
    if (event.type === 'llm/retry') turn.lastRetry = describeRetry(event.data);
    if (event.type === 'assistant/message') turn.text = assistantTextOf(event);
    if (event.type === 'turn/end' && !turn.settled) {
      turn.settled = true;
      demand?.(turn.text === expectedText,
        `page session "${session.id}" assistant text is "${turn.text}"`);
      const failure = failureOf(event.data?.reason, turn.lastRetry);
      emit('write.turn.settled', {
        sessionId: session.id, events: turn.events, text: turn.text,
        ...(failure === null ? {} : { error: failure }),
      });
    }
  };
};
