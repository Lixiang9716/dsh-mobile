// dsh:logging-exempt (probe harness plumbing; the scenario logs the outcome)
/**
 * scenario/probe-respond-await.js — the settings-probe response waiter
 * (split from composer-web-live.js at loop-q). The probes synthesize
 * `api.request` frames at the same wire boundary the page uses and wait for
 * the matching `api.respond` in the posted-frame record.
 *
 * WHY THE WAIT MUST YIELD TO THE HOST (loop-q): a claimed handler's answer
 * may cross the EMBEDDER — the 插件 inventory's workspace tier reads its
 * registry document through the gateway (`fsRead`, #334/#346) — and on the
 * device seats that settle is queued on the runtime looper
 * (JsRuntime.post): it only lands when the JS job queue empties and the
 * native pump returns. The historical wait spun `await Promise.resolve()` —
 * pure microtasks never empty the queue — so a correct handler starved, the
 * probe failed, the scenario completed-fail, and every later bus frame
 * re-reported the FAIL line (14,037 logcat lines on the 2026-10-04 battery
 * seat). The `yieldTurn` here is a tiny gateway call: its OWN settle queues
 * right behind the answers this wait is waiting for, so awaiting it hands
 * the looper its turn — the earlier settles land with the same return. The
 * deadline keeps the failure loud when a claimed handler genuinely never
 * settles; a boot with no gateway at all keeps the historical microtask
 * budget verbatim (there the answer can only ride jobs already queued).
 */

/** How long one probe may wait for its claimed handler's answer. The legs'
 * work is one gateway document read (or a handful, on the manager legs) —
 * milliseconds on a healthy seat; the deadline exists so a dead one fails
 * loud instead of hanging the boot. */
export const PROBE_RESPOND_TIMEOUT_MS = 5000;

/**
 * Build the `awaitRespond(rpcId)` the probe legs share.
 * @param frames - the scenario's posted-frame record (the api.respond frames
 *   land here through the same `post` the runtime half answers with).
 * @param fail - the scenario's fail-loud completion (called, then an Error
 *   is thrown — the demand contract the callers already handle).
 * @param yieldTurn - async no-result: one turn that ends only after the
 *   host had a chance to run (the scenario passes a minimal gateway call —
 *   its settle queues on the same looper as the settles being awaited).
 *   Optional: absent, the waiter keeps the historical microtask budget.
 * @returns async (rpcId) => the respond frame's `result` payload.
 */
export const makeProbeAwaiter = ({ frames, fail, yieldTurn, timeoutMs = PROBE_RESPOND_TIMEOUT_MS }) => {
  const findRespond = (rpcId) => frames.find((f) => f.type === 'api.respond' && f.rpcId === rpcId);
  const demandFail = (reason) => {
    fail(reason);
    throw new Error(reason);
  };
  // The historical budget, kept verbatim for the gatewayless shape: the
  // answer can only ride jobs already queued there.
  const waitMicrotasks = async (rpcId) => {
    let guard = 0;
    while (findRespond(rpcId) === undefined && guard++ < 10000) {
      await Promise.resolve();
    }
    const respond = findRespond(rpcId);
    if (respond === undefined) {
      demandFail(`no api.respond for the ${rpcId} probe `
        + `(microtask budget exhausted; no gateway to yield the host with)`);
    }
    return respond.result;
  };
  return async (rpcId) => {
    if (typeof yieldTurn !== 'function') return await waitMicrotasks(rpcId);
    const startedAt = Date.now();
    let turns = 0;
    for (;;) {
      const respond = findRespond(rpcId);
      if (respond !== undefined) return respond.result;
      const waited = Date.now() - startedAt;
      if (waited > timeoutMs) {
        demandFail(`no api.respond for the ${rpcId} probe `
          + `(${turns} host turn${turns === 1 ? '' : 's'} over ${waited}ms — `
          + 'the claimed handler never settled)');
      }
      turns += 1;
      await yieldTurn();
    }
  };
};
