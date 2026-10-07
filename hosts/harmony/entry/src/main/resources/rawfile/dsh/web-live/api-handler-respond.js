// dsh:logging-exempt (drive plumbing; the scenario logs the outcome)
/**
 * web-live/api-handler-respond.js — the claimed-endpoint answer guard the
 * write drives share (split from composer-web-live.js at loop-w2). The
 * historical drive legs answered a handler RESOLUTION and treated every
 * handler REJECTION as a drive-killing defect WITHOUT posting any
 * `api.respond` — so a structured refusal (the malformed-but-valid-JSON
 * session/prompt envelope's `gateway/bad-request` thrown by
 * makePromptSession's shape check, upstream/web-write.js:316) reached the
 * scenario fail() alone. On a resident seat the drive has long finished by
 * then, the suppressed fail lands nowhere (web-live/scenario-verdict.js),
 * and the HTTP caller waited the FULL RESPOND_TIMEOUT_MS (30s,
 * CarrierAPIBridge.kt:302) before the carrier's `gateway/unimplemented`
 * timeout envelope answered (measured 2026-10-05: three malformed-envelope
 * probes hung 30.0s each; well-formed payloads answered in 21-33ms).
 *
 * THE GUARD: a thrown handler ALWAYS answers its caller in band — exactly
 * the frame the drive would have posted for a resolution, with the
 * `ok:false` error half — before any verdict question is asked. Then the
 * verdict: a STRUCTURED rejection (the adapter's `remoteError` shape or the
 * vendored upstream RemoteError — the same two pass-throughs
 * upstream/web-write.js's errorOf maps through) is the handler's deliberate
 * answer to a client-caused condition (bad envelope, unknown session, a
 * read-only preset); it is answered and the drive stays alive. An
 * UNSTRUCTURED throw is a runtime defect: it still kills the drive through
 * the scenario's fail gate UNCHANGED (#366/#371 semantics — first verdict
 * sticky, suppressed deltas warn once) — but only after the caller is
 * answered, so even a defect never black-holes a connection. A handler that
 * throws SYNCHRONOUSLY (a shape the surface map's every-handler-async
 * discipline forbids — web-write-catalog.js:262 records the seat death it
 * once caused — but this guard does not trust) lands in the same rejection
 * leg: the deferred call converts the throw into a rejection before `.then`
 * is attached.
 */

/** Whether one thrown value is a STRUCTURED wire error — the adapter's own
 * `remoteError` shape (upstream/web-write.js:107) or the vendored upstream
 * RemoteError (identified structurally by its `isDSHRemoteError` marker with
 * a string code). Anything else is an unstructured defect. */
export const isWireError = (error) => error !== null && typeof error === 'object'
  && (error.remote === true
    || (error.isDSHRemoteError === true && typeof error.code === 'string'));

/**
 * Build the write drive's claimed-endpoint runner (`onHandler`).
 * @param post - the bus post fn (the api.respond frames toward the carrier).
 * @param fail - the scenario's fail gate (web-live/scenario-verdict.js) —
 *   called ONLY for an unstructured throw, never for a structured refusal.
 * @param errorOf - upstream/web-write.js's thrown-value → wire-triple map.
 * @returns (msg, outcome) => void — call with every `kind: 'handler'`
 *   deliver outcome; the runner posts the one api.respond frame (success or
 *   in-band error) and fails the drive only on a genuine defect.
 */
export const makeApiHandlerRespond = ({ post, fail, errorOf }) => {
  const onHandler = (msg, outcome) => {
    Promise.resolve().then(() => outcome.run()).then(
      (value) => post({ type: 'api.respond', rpcId: msg.rpcId, result: { ok: true, value } }),
      (error) => {
        // The loop-w2 guard: the caller is answered FIRST, in band — the
        // HTTP forward otherwise rides the full RESPOND_TIMEOUT into the
        // carrier's gateway/unimplemented envelope.
        const wire = errorOf(error);
        post({
          type: 'api.respond', rpcId: msg.rpcId,
          result: { ok: false, error: wire },
        });
        // A structured refusal is an answered client, not a defect — the
        // drive stays alive. An unstructured throw is still a defect: fail
        // loud (the #366/#371 gate semantics untouched), now with the
        // caller answered instead of black-holed.
        if (!isWireError(error)) {
          fail(`claimed endpoint ${msg.endpoint} failed: ${wire.code}: ${wire.message}`);
        }
      },
    ).catch(fail);
  };
  return onHandler;
};
