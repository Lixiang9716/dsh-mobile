/**
 * transport-tokens.mjs — the single source of truth for the repo's
 * cross-layer transport/E2E token strings: the log-line prefix, the verdict
 * marker, the logcat/hilog tag, the transport tag family, the gateway audit
 * prefix, and the manifest identity tokens.
 *
 * Why a table at all: each of these strings is spelled INDEPENDENTLY by four
 * layers — the C sink (dsh_runtime_host.c, the JNI/NAPI glue), the platform
 * emitters (ArkTS/Kotlin/Swift), the Node drivers (hosts/<plat>/ci/*.mjs), and
 * the shell runners (hosts/<plat>/ci/*.sh, runtime/dsh/ci/*.sh). Before this
 * table existed no artifact owned them, and the layers drifted into three
 * concurrent verdict spellings, a mismatched result tag, and a wrong-scoped
 * manifest caller id — the 2026-10 rename post-mortem counted four incidents
 * of this class (the retired spellings are banned outright by
 * tools/check-transport-tokens.mjs, which owns the forbidden list).
 *
 * Who consumes which token (the layer map tools/check-transport-tokens.mjs
 * enforces; keep both files in sync when a layer legitimately drops or
 * gains a token):
 *
 *   logLinePrefix    C sink (DSH_LOG_PREFIX) + every emitter/driver/runner
 *                    that greps the E2E stream. The C sink appends one
 *                    space after the marker; the token here is the marker.
 *   verdictMarker    C verdict glue (napi/JNI), ArkTS phases, Node drivers,
 *                    shell runners — the scenario PASS/FAIL line every
 *                    E2E verdict matcher keys on.
 *   logcatTag        Android logcat / harmony hilog tag (C glue TAG defines,
 *                    Kotlin TAG constants, the runners' logcat/hilog
 *                    filters). NOTE: this token is a strict PREFIX of the
 *                    others, so the checker counts standalone spellings
 *                    only (not occurrences inside longer tokens).
 *   resultTag        the gateway result tag the sessions emit and the
 *                    runners count (C JNI scenario bridge, Kotlin session
 *                    hosts, ArkTS V2 web phase, shell runners).
 *   auditTag / uiTag the debug-plane stream tags (Kotlin GatewayCore emits;
 *                    the runners grep).
 *   auditLinePrefix  the gateway audit line's own stdout prefix — NOT part
 *                    of the dsh.runtime.* family by long-standing E2E
 *                    contract (the m2 gateway.audit matcher predates the
 *                    family). Emitted by Kotlin/ArkTS/Swift gateway cores,
 *                    grepped by the runners.
 *   scenarioModule   the createLogger module id every scenario passes —
 *                    the manifest E2E matchers key on it inside each
 *                    dsh.runtime.log line's JSON.
 *   appId            the Android application id (package declarations,
 *                    gradle/CI configs, the runners' adb am commands).
 *   callerId         the scenario manifest's id — the gateway permission
 *                    record's caller identity (manifest.json + the gateway
 *                    cores + the stager's byte-sync comment).
 *
 * Scope note: these are the repo's OWN transport/E2E conventions — not the
 * frozen gateway contract (contract/, D5). Renaming a value here is a
 * cross-host rename with device re-install blast radius, not a contract
 * proposal; the transport-tokens gate makes the rename's missed spots red.
 *
 * Non-JS layers keep their string literals on purpose (no code generation):
 * the C sink must stay a freestanding compilation unit, and ArkTS/Kotlin/
 * Swift have no JS module graph to import from — the checker pins their
 * literals to THIS table instead. See tools/check-transport-tokens.mjs.
 */

/** The JSON-shaped table itself — the one object every consumer and the
 * checker read. Frozen: a token edited in flight is exactly the drift this
 * module exists to prevent. */
export const TRANSPORT_TOKENS = Object.freeze({
  logLinePrefix: 'dsh.runtime.log:',
  verdictMarker: 'dsh.runtime.verdict:',
  logcatTag: 'dsh.runtime',
  resultTag: 'dsh.runtime.result',
  auditTag: 'dsh.runtime.audit',
  uiTag: 'dsh.runtime.ui',
  auditLinePrefix: 'dsh.gateway.audit: ',
  scenarioModule: 'dsh.scenario',
  appId: 'com.dshmobile.host',
  callerId: 'dsh.runtime.scenario',
});

// Named single-token exports — the ergonomic import face for the closure's
// JS (scenario files import { scenarioModule }; keep the list and the table
// keys identical, both directions).
export const logLinePrefix = TRANSPORT_TOKENS.logLinePrefix;
export const verdictMarker = TRANSPORT_TOKENS.verdictMarker;
export const logcatTag = TRANSPORT_TOKENS.logcatTag;
export const resultTag = TRANSPORT_TOKENS.resultTag;
export const auditTag = TRANSPORT_TOKENS.auditTag;
export const uiTag = TRANSPORT_TOKENS.uiTag;
export const auditLinePrefix = TRANSPORT_TOKENS.auditLinePrefix;
export const scenarioModule = TRANSPORT_TOKENS.scenarioModule;
export const appId = TRANSPORT_TOKENS.appId;
export const callerId = TRANSPORT_TOKENS.callerId;

export default TRANSPORT_TOKENS;

/** The table as stable JSON — for tooling that must not import ES modules
 * (a shell one-liner, a future non-JS generator). Pinned as a string so a
 * key rename here is a visible diff, not a silent shape change. */
export const TRANSPORT_TOKENS_JSON = JSON.stringify(TRANSPORT_TOKENS, null, 2);
