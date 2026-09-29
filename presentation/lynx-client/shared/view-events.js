// dsh:logging-exempt (pure data machinery: no I/O — the driver boundary owns logging)
/**
 * view-events.js — the closed view-event vocabulary and the fail-loud
 * validators for both seam directions (event-model iron law #2 and rule 5:
 * unknown values abort with the offending name).
 *
 * The skin ← driver direction carries exactly three event types; the
 * skin → driver direction carries exactly four intents. Skin, adapter and
 * driver ship as one package at one version, so there is NO forward
 * tolerance: an unknown type/kind/payload shape throws, listing the
 * offender — a silent drop here would strand the mount-blank or the
 * stop-button invariants this model exists to keep.
 *
 *   message-delta    — the live streaming channel: start / text / reasoning
 *                      / end markers of one assistant attempt
 *   tool-card-phase  — one tool card's lifecycle: streaming (args still
 *                      building) → waiting (durable call named it) → ok|fail
 *                      (result in hand, card collapses to its output)
 *   session-settled  — durable facts and shell state: user-message,
 *                      assistant-message, creation, title, turn-end, status,
 *                      sessions, connection, prompt-admitted, system,
 *                      seed-start, seed-end
 *
 * Intents (driver direction): submit, cancel, select-session, new-session.
 * new-session exists beside select-session because the drawer's 新建会话
 * button is a wire action (session/create), not pure presentation.
 */

export const VIEW_EVENT_TYPES = ['message-delta', 'tool-card-phase', 'session-settled'];

export const DELTA_KINDS = ['start', 'text', 'reasoning', 'end'];
export const TOOL_PHASES = ['streaming', 'waiting', 'ok', 'fail'];
export const SETTLED_KINDS = [
  'user-message', 'assistant-message', 'creation', 'title', 'turn-end',
  'status', 'sessions', 'connection', 'prompt-admitted', 'system',
  'seed-start', 'seed-end',
];
export const CONNECTION_STATES = ['connecting', 'open', 'closed'];
export const STATUS_TONES = ['info', 'warn'];

export const INTENT_TYPES = ['submit', 'cancel', 'select-session', 'new-session'];

const fail = (kind, offender) => {
  throw new TypeError(`fail loud: unknown ${kind}: ${JSON.stringify(offender)}`);
};

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool = (v) => typeof v === 'boolean';
const has = (event, key, kind) => {
  if (event[key] === undefined) fail(`${kind} payload (missing ${key})`, event);
};

const assertDelta = (event) => {
  has(event, 'attemptId', 'message-delta');
  has(event, 'turn', 'message-delta');
  has(event, 'step', 'message-delta');
  has(event, 'kind', 'message-delta');
  if (!isStr(event.attemptId)) fail('message-delta attemptId', event);
  if (!isNum(event.turn) || !isNum(event.step)) fail('message-delta turn/step', event);
  if (!DELTA_KINDS.includes(event.kind)) fail('message-delta kind', event);
  if ((event.kind === 'text' || event.kind === 'reasoning') && !isStr(event.text)) {
    fail('message-delta text payload', event);
  }
};

const assertToolPhase = (event) => {
  has(event, 'callId', 'tool-card-phase');
  has(event, 'phase', 'tool-card-phase');
  if (!isStr(event.callId)) fail('tool-card-phase callId', event);
  if (!TOOL_PHASES.includes(event.phase)) fail('tool-card-phase phase', event);
  if (event.phase === 'streaming' && !isStr(event.argsDelta)) {
    fail('tool-card-phase argsDelta', event);
  }
  if (event.phase === 'waiting' && !(isStr(event.name) && isStr(event.args))) {
    fail('tool-card-phase waiting payload (name, args)', event);
  }
  if ((event.phase === 'ok' || event.phase === 'fail') && !isStr(event.output)) {
    fail('tool-card-phase output payload', event);
  }
};

const assertSettled = (event) => {
  has(event, 'kind', 'session-settled');
  if (!SETTLED_KINDS.includes(event.kind)) fail('session-settled kind', event);
  switch (event.kind) {
    case 'user-message':
      if (!isStr(event.text)) fail('user-message text', event);
      break;
    case 'assistant-message':
      if (!isNum(event.turn) || !isNum(event.step) || !isStr(event.markdown)
        || !isStr(event.reasoning) || !isBool(event.interrupted)) {
        fail('assistant-message payload', event);
      }
      break;
    case 'creation':
      if (!Array.isArray(event.files)) fail('creation files', event);
      break;
    case 'title':
      if (!(event.title === undefined || isStr(event.title))) fail('title', event);
      break;
    case 'turn-end':
      if (!isStr(event.reason)) fail('turn-end reason', event);
      break;
    case 'status':
      if (!isStr(event.text) || !STATUS_TONES.includes(event.tone)) {
        fail('status payload', event);
      }
      break;
    case 'sessions':
      if (!Array.isArray(event.items)) fail('sessions items', event);
      break;
    case 'connection':
      if (!CONNECTION_STATES.includes(event.status)) fail('connection status', event);
      break;
    case 'prompt-admitted': case 'seed-start': case 'seed-end':
      break;
    case 'system':
      if (!isStr(event.label) || !isStr(event.type)) fail('system payload', event);
      break;
    default:
      fail('session-settled kind', event);
  }
};

/** Validate one driver → skin view event; throws on anything outside the
 * closed set. Returns the event (chainable). */
export const assertViewEvent = (event) => {
  if (event === null || typeof event !== 'object') fail('view event', event);
  has(event, 'type', 'view event');
  if (!VIEW_EVENT_TYPES.includes(event.type)) fail('view event type', event);
  if (event.type === 'message-delta') assertDelta(event);
  else if (event.type === 'tool-card-phase') assertToolPhase(event);
  else assertSettled(event);
  return event;
};

/** Validate one skin → driver intent; throws on anything outside the
 * closed intent set (same-package-same-version: no forward tolerance). */
export const assertIntent = (intent) => {
  if (intent === null || typeof intent !== 'object') fail('intent', intent);
  if (!INTENT_TYPES.includes(intent.type)) fail('intent type', intent);
  switch (intent.type) {
    case 'submit':
      if (!isStr(intent.text) || intent.text.trim() === '') {
        fail('submit text', intent);
      }
      break;
    case 'select-session':
      if (!isStr(intent.sessionId) || intent.sessionId === '') {
        fail('select-session sessionId', intent);
      }
      break;
    case 'cancel': case 'new-session':
      break;
    default:
      fail('intent type', intent);
  }
  return intent;
};

// ---- constructor helpers (validate at birth — nothing emits an
// unvalidated event by accident) ---------------------------------------------

export const makeDelta = (kind, payload) =>
  assertViewEvent({ type: 'message-delta', kind, ...payload });

export const makeToolPhase = (phase, payload) =>
  assertViewEvent({ type: 'tool-card-phase', phase, ...payload });

export const makeSettled = (kind, payload) =>
  assertViewEvent({ type: 'session-settled', kind, ...payload });

export const makeIntent = (type, payload) =>
  assertIntent({ type, ...payload });
