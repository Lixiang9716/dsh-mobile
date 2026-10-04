/**
 * upstream/retry-telemetry.js — the llm/retry release-visibility leg (loop-x2).
 *
 * The vendored @deepseek-ai/dsh-llm-retry plugin answers `agent/request-error`
 * by appending an `llm/retry` event to the SESSION JOURNAL (its backoff():
 * the only emission — no log call, no context event). Durable, but observable
 * only through the mux session/follow WS stream; the "Retrying model request"
 * string lives in the dsh-client-ui-chat banner component, so a release or
 * headless seat shows ZERO retry trace in logcat while retries schedule
 * (measured 2026-10-05, battery-r14 W1 airplane drive on release 318fb22e:
 * `grep -i retry` over the whole logcat buffer held no DSH line while the
 * journal recorded llm/retry 1/5 TRANSPORT twice). The loop-x principle —
 * new failure classes stay release-visible — owes the operator one line per
 * scheduled retry.
 *
 * This plugin rides dsh-session's `session/event` append dispatch (the same
 * fan-out the model-selection holder and the mux streams subscribe) and turns
 * every `llm/retry` journal append into ONE log.warn — warn survives the
 * release strip (logger.js RELEASE_CRITICAL_LEVELS). Retry chains are bounded
 * by the provider policy (maxRetries, 5 on the shipped route), so this is at
 * most one warn per attempt of one chain, never a storm; the message carries
 * the attempt ordinal and the failure category (e.g. "attempt 1/5: TRANSPORT
 * gateway SSE stream failed: Connection reset").
 *
 * Scope note: this is retry TELEMETRY on the unified sink. It does not judge
 * scenario outcomes (the scenario verdict gates keep their own semantics) and
 * does not touch the recovery flow — a warn listener failure is contained by
 * the journal's per-listener containment, never by this module.
 */
import { createLogger } from 'logger.js';

const log = createLogger('dsh.retry-telemetry');

/** The one-line human form of one scheduled retry: the attempt ordinal and
 * the failure category. The always-retry policy journals no maxRetries
 * ceiling and renders as a bare "attempt N". A malformed payload still
 * renders (UNKNOWN category) — telemetry never throws into the listener. */
export const describeLlmRetry = (data) => {
  log.debug('describe retry attempt', { retry: data?.retry, maxRetries: data?.maxRetries, code: data?.failure?.code });
  const attempt = typeof data?.maxRetries === 'number'
    ? `attempt ${data.retry}/${data.maxRetries}`
    : `attempt ${data?.retry}`;
  const code = data?.failure?.code ?? 'UNKNOWN';
  const detail = data?.failure?.message;
  return `${attempt}: ${code}${detail ? ` ${detail}` : ''}`;
};

export const name = 'retry-telemetry';

export const apply = (ctx) => {
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'llm/retry') return;
    const data = event.data ?? {};
    log.warn(`llm request retry scheduled — ${describeLlmRetry(data)}`, {
      provider: data.provider,
      turn: data.turn,
      step: data.step,
      retryId: data.retryId,
    });
  });
  log.info('llm retry telemetry mounted', {
    on: 'session/event llm/retry → one release-visible warn per scheduled attempt',
  });
};
