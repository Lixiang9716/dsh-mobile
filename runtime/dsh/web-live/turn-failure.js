// dsh:logging-exempt (pure helpers; emission rides the caller)
/**
 * web-live/turn-failure.js — the settle-path failure summarizer (the P1
 * 300s-silent-hang round, 2026-10-09).
 *
 * The measured defect: a real turn whose wire requests hang (bigmodel
 * delivered no response headers twice in a row) burned the platform's 300s
 * httpFetch read timeout per attempt, the 300s turn watchdog killed the turn
 * first as an ABORT, and the turn settled with `text:""` and NO failure
 * evidence anywhere — the capture log's `write.turn.settled {events:14,
 * text:""}` (session-4331764d) and a user staring at an empty reply. Two
 * wedges stacked: no record carried the reason, and the vendored chat UI
 * renders a failure notice only for `turn/end` reasons of kind "error"
 * (dsh-client-ui-chat failureFrom) — a watchdog abort renders nothing.
 *
 * This module is the record half of the fix: the settle projection
 * (composer-web-live / harmony-composer-live-write installTurnEvidence) folds
 * the `turn/end` reason and the session's last `llm/retry` journal event into
 * one structured `error` object on the settled record, so every empty-text
 * settle NAMES what happened. The watchdog itself (upstream/turn-watchdog.js)
 * is correct — the kill is honest; what was broken is that the reason died
 * with it. The deadline half (fail a stalled wire request fast, so the retry
 * ladder exhausts into a kind-"error" turn end the page CAN render) lives in
 * the host: HttpFetch.ets's stalled-read guard.
 */

/** The structured failure of one settled turn, from its `turn/end`
 * `data.reason` (the vendored agent-loop's TurnEndReason) plus the turn's
 * last `llm/retry` journal line (`null` when the reason is a normal
 * completion, or when neither side carries anything usable). Shape:
 * `{kind, code, message, lastRetry?}` — `kind` mirrors the reason kind
 * ("error" | "aborted"), `code` the provider-neutral LlmError code or the
 * abort cause's kind, `message` the human reason, `lastRetry` the one-line
 * form of the newest scheduled retry (the closest witness to WHY a
 * watchdog-killed turn was stuck). */
export const turnFailureOf = (reason, lastRetry) => {
  if (reason === null || typeof reason !== 'object') return null;
  if (reason.kind === 'error') {
    const error = reason.error ?? {};
    return {
      kind: 'error',
      code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
      message: typeof error.message === 'string' ? error.message : '',
      ...(lastRetry === undefined ? {} : { lastRetry }),
    };
  }
  if (reason.kind === 'aborted') {
    const cause = reason.reason ?? {};
    const causeKind = typeof cause.kind === 'string' ? cause.kind : 'unknown';
    return {
      kind: 'aborted',
      code: causeKind,
      message: typeof cause.message === 'string' ? cause.message : `turn aborted (${causeKind})`,
      ...(lastRetry === undefined ? {} : { lastRetry }),
    };
  }
  return null; // completed / blocked / max-tokens: not failures
};
