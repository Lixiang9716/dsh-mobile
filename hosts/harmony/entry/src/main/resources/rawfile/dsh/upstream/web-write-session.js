// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-session.js — the SESSION DEEP-PAGE legs (decision D9,
 * W-RPC leg; the T-0049 tail item + T-0050's session leg): the transcript-
 * facing reads and queue mutations the official page drives beyond the
 * follow journal — session/page, session/search, session/rename,
 * session/updateQueue, and the desktop-opener gate session/
 * canOpenWorkspacePath. Each handler mirrors the upstream session-
 * controller's semantics at the pin (packages/api/session-controller/src/
 * commands.ts + history.ts + list.ts, read from the dsh-tests tree),
 * narrowed to the ATTACHED-STORE subset this profile serves: live sessions
 * only (no cold persistence reads), one process, few sessions — so the
 * cold-session machinery (dsh-session-query's sqlite corpus, the projection
 * cache, agent resume) is replaced by direct reads over ctx.sessions /
 * ctx.agents. Everything the narrowing cannot answer stays a structured
 * refusal with the upstream code and message shapes — fail loud, never
 * faked.
 *
 * Stays UNCLAIMED after this module lands (pinned in the coverage probe's
 * gap list, with the honest reason):
 *   - session/attachment — the desktop leg authorizes from the journal and
 *     reads bytes from the ATTACHMENT STORE (commands.attachment →
 *     ctx.attachments.readImage); this host mounts no attachment store and
 *     no image can enter it (fileUploads/upload is unimplemented), so there
 *     are no bytes to serve.
 *   - session/openWorkspacePath — the native desktop opener; its asker is
 *     gated off by canOpenWorkspacePath answering false.
 *   - sessionReferenceResolver/candidates — the discovery half is derivable
 *     from the store, but the resolver's context-PREPARATION half (the
 *     vendored dsh-session-reference pre-step that turns a mention into
 *     model context) is not mounted, so a claimed discovery face would let
 *     the page insert mentions that never resolve — a silent lie, not a
 *     leg. Vendoring the package (D6) is its own change.
 */
import { freezeMessage } from '@deepseek-ai/dsh-llm';
import { remoteError } from 'upstream/web-write.js';
import { wireEvent } from 'upstream/web-write-streams.js';

/** The live agent a wire identity names, or the upstream not-found refusal
 * (the same resolution every session-addressing handler uses). */
const liveAgent = (ctx, sessionId) => {
  const agent = ctx.agents.get(sessionId);
  if (agent === undefined) {
    throw remoteError('session/not-found',
      `session ${JSON.stringify(sessionId ?? null)} is not attached to the mobile runtime`,
      { sessionId: sessionId ?? null });
  }
  return agent;
};

//#region session/page — history.ts at the pin, narrowed to live sessions

/** The message types a page counts against maxMessages (history.ts
 * MESSAGE_TYPES). */
const PAGE_MESSAGE_TYPES = new Set(['user/message', 'assistant/message']);

/** isAppendSurfaceEvent from the vendored session package, linked HERE only
 * (a dynamic import, the userInvocableFilter pattern): web-write.js
 * composes on the bare spine-less embed too, and a static dsh-session edge
 * would demand the package on every leg whether or not the page boots. */
let appendSurfaceEvent = undefined;
const isAppendSurfaceEvent = async (event) => {
  if (appendSurfaceEvent === undefined) {
    const mod = await import('@deepseek-ai/dsh-session');
    appendSurfaceEvent = mod.isAppendSurfaceEvent;
    if (typeof appendSurfaceEvent !== 'function') {
      throw new Error(`dsh-session import shape: ${Object.keys(mod).join(',')}`);
    }
  }
  return appendSurfaceEvent(event);
};

/** The address a page names, resolved against the live store (history.ts
 * sourceFor + rejectNotFound + validateAddress, minus the subagent
 * projection identity checks this host cannot run — no subagent service is
 * mounted, so no subagent-origin session can exist here and the origin
 * checks below always decide). */
const pageSource = (ctx, address) => {
  if (address === null || typeof address !== 'object'
    || (address.kind !== 'session' && address.kind !== 'subagent')) {
    throw remoteError('gateway/bad-request',
      'session page address must be a session or subagent address', {});
  }
  const sessionId = address.kind === 'session'
    ? address.sessionId : address.childSessionId;
  const session = ctx.sessions.get(sessionId);
  if (session === undefined || session.header?.cwd === undefined) {
    if (address.kind === 'subagent') {
      throw remoteError('subagent/not-found', 'subagent is unavailable', {
        parentSessionId: address.parentSessionId ?? null,
        childSessionId: address.childSessionId ?? null,
      });
    }
    throw remoteError('session/not-found',
      `session ${JSON.stringify(sessionId ?? null)} not found`,
      { sessionId: sessionId ?? null });
  }
  if (address.kind === 'session') {
    if (session.header.origin === 'subagent') {
      throw remoteError('session/agent-busy',
        'subagent Sessions require their durable parent address',
        { reason: 'use subagent delivery for this child session' });
    }
    return session;
  }
  if (session.header.origin !== 'subagent'
    || session.header.parentSession !== address.parentSessionId) {
    throw remoteError('subagent/unauthorized',
      'subagent does not belong to the supplied parent',
      { childSessionId: address.childSessionId });
  }
  return session;
};

/** history.ts validatePageRequest: the cursor and window bounds. */
const validatePageRequest = (request) => {
  const { throughSeq, beforeSeq, maxMessages } = request;
  if (!Number.isSafeInteger(throughSeq) || throughSeq < -1
    || Object.is(throughSeq, -0)) {
    throw remoteError('gateway/bad-request',
      'throughSeq must be an integer greater than or equal to -1', {});
  }
  if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq)
    || beforeSeq < 0 || Object.is(beforeSeq, -0))) {
    throw remoteError('gateway/bad-request',
      'beforeSeq must be a non-negative safe integer', {});
  }
  if (maxMessages !== undefined
    && (!Number.isSafeInteger(maxMessages) || maxMessages <= 0)) {
    throw remoteError('gateway/bad-request',
      'maxMessages must be a positive safe integer', {});
  }
};

/** history.ts paginate: one message-aligned BACKWARD window of the log.
 * The cut is inclusive of the maxMessages-th message's whole source group
 * (its sourceEventSeqs ride along), so a page never splits a derived
 * message from its sources. */
const paginatePage = async (events, beforeSeq, maxMessages, throughSeq) => {
  const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1);
  let count = 0;
  let cut = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!PAGE_MESSAGE_TYPES.has(event.type)
      || (await isAppendSurfaceEvent(event)) !== true) continue;
    count += 1;
    let groupStart = event.seq;
    const sources = event.sourceEventSeqs;
    if (sources !== undefined) {
      for (const source of sources) {
        if (source < groupStart) groupStart = source;
      }
    }
    if (count >= maxMessages) {
      cut = groupStart;
      break;
    }
  }
  return { events: events.slice(cut, end), hasMore: cut > 0 };
};

/** session/page: one message-aligned history window without waking the
 * agent (history.ts commands.page at the pin). */
export const makeSessionPageHandlers = (ctx) => ({
  'session/page': async (args) => {
    const request = args?.request ?? args ?? {};
    validatePageRequest(request);
    const session = pageSource(ctx, request.address);
    const events = session.snapshotEvents();
    const cursor = events.length > 0 ? events[events.length - 1].seq : -1;
    if (request.throughSeq > cursor) {
      throw remoteError('gateway/bad-request',
        `session page through seq ${String(request.throughSeq)} `
          + `is past cursor ${String(cursor)}`, {});
    }
    if (request.throughSeq >= 0 && events[request.throughSeq]?.seq
      !== request.throughSeq) {
      throw remoteError('gateway/internal',
        `session log does not contain through seq ${String(request.throughSeq)}`, {});
    }
    const page = await paginatePage(events,
      request.beforeSeq, request.maxMessages ?? 50, request.throughSeq);
    return {
      records: page.events.map((event) => wireEvent(event)),
      hasMore: page.hasMore,
    };
  },
});

//#endregion

//#region session/search — list.ts at the pin, narrowed to a live scan

/** list.ts SESSION_SEARCH_RESULT_LIMIT / SESSION_SEARCH_SNIPPET_MAX_CODE_
 * POINTS / SESSION_SEARCH_QUERY_MAX_CHARS. */
const SEARCH_RESULT_LIMIT = 20;
const SEARCH_SNIPPET_MAX_CODE_POINTS = 240;
const SEARCH_QUERY_MAX_CHARS = 500;

/** list.ts normalizeSearchQuery: trim, then the three rejections. */
const normalizeSearchQuery = (query) => {
  const normalized = String(query ?? '').trim();
  if (normalized.length === 0) {
    throw remoteError('gateway/bad-request',
      'session search query must not be empty', {});
  }
  if (normalized.length > SEARCH_QUERY_MAX_CHARS) {
    throw remoteError('gateway/bad-request',
      'session search query must contain at most '
        + `${String(SEARCH_QUERY_MAX_CHARS)} UTF-16 code units`, {});
  }
  if (normalized.includes('\0')) {
    throw remoteError('gateway/bad-request',
      'session search query must not contain NUL', {});
  }
  return normalized;
};

/** The text blocks of one message-carrying journal event (the search
 * corpus: user/message content blocks + assistant/message message blocks —
 * the list.ts eventFilters' two types), append-origin only: replacement
 * copies are model-only projections, and the shadowed history they replace
 * is not the current surface (isAppendSurfaceEvent's own doc). */
const searchableTexts = async (event) => {
  if (!PAGE_MESSAGE_TYPES.has(event.type)
    || (await isAppendSurfaceEvent(event)) !== true) return [];
  const blocks = event.type === 'user/message'
    ? event.data?.content
    : event.data?.message?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
};

/** list.ts truncateUnicodeCodePoints: the longest prefix within the code-
 * point budget. */
const truncateCodePoints = (value, maximum) => {
  let count = 0;
  let end = 0;
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end);
    count += 1;
    end += codePoint.length;
  }
  return value;
};

/** A bounded, match-centered plain-text snippet (the controller's contract:
 * a string within the code-point budget; the FTS5 highlight plumbing that
 * builds the desktop's exact window is not mounted, so the scan builds one
 * directly — whitespace-normalized, '…'-clipped, at most
 * SEARCH_SNIPPET_MAX_CODE_POINTS code points). */
const snippetOf = (text, needle) => {
  const clean = text.replace(/\s+/gu, ' ').trim();
  const at = clean.toLocaleLowerCase().indexOf(needle);
  if (at < 0) return truncateCodePoints(clean, SEARCH_SNIPPET_MAX_CODE_POINTS);
  const start = Math.max(0, at - 80);
  const end = Math.min(clean.length, at + needle.length + 80);
  const body = clean.slice(start, end);
  const clipped = (start > 0 ? '…' : '') + body + (end < clean.length ? '…' : '');
  return truncateCodePoints(clipped, SEARCH_SNIPPET_MAX_CODE_POINTS);
};

/** The first matching message text in one session's log, or undefined. */
const firstSearchHit = async (session, needle) => {
  for (const event of session.snapshotEvents()) {
    for (const text of await searchableTexts(event)) {
      if (text.toLocaleLowerCase().includes(needle)) {
        return snippetOf(text, needle);
      }
    }
  }
  return undefined;
};

/** session/search: literal substring search over the live sessions'
 * current-surface message text (list.ts commands.search at the pin,
 * narrowed: the cold sqlite corpus (dsh-session-query) is not mounted, so
 * the attached logs are scanned directly; the summary order is the one
 * session/list serves). */
export const makeSessionSearchHandlers = (ctx) => ({
  'session/search': async (args) => {
    const request = args?.request ?? args ?? {};
    const needle = normalizeSearchQuery(request.query).toLocaleLowerCase();
    const summaries = ctx.sessions.list().map((session) => ({
      session,
      updatedAt: session.header?.createdAt ?? 0,
    }));
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    const items = [];
    let more = false;
    for (const { session } of summaries) {
      const hit = await firstSearchHit(session, needle);
      if (hit === undefined) continue;
      if (items.length >= SEARCH_RESULT_LIMIT) {
        more = true;
        break;
      }
      items.push({ sessionId: session.id, snippet: hit });
    }
    return { items, hasMore: more };
  },
});

//#endregion

//#region session/rename — commands.rename + session-title at the pin

/** The accepted-title byte budget (session-title's configured maxTitleBytes;
 * the session-controller composition's deployment value — 40 UTF-8 bytes —
 * pinned in its rename spec). */
const TITLE_MAX_BYTES = 40;

/** session-title normalize.ts: strip OS-command and control escapes,
 * collapse whitespace to one line. */
const cleanTitleText = (input) => input
  .replace(/(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu, '')
  .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, '')
  .replace(/\u001B[@-_]/gu, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
  .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, '')
  .replace(/\s+/gu, ' ')
  .trim();

/** session-title truncateTitleUtf8: the longest code-point prefix within
 * the UTF-8 byte budget. */
const truncateTitleUtf8 = (input, maxBytes) => {
  const buffer = globalThis.Buffer;
  if (buffer === undefined) return input;
  if (buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let used = 0;
  let output = '';
  for (const character of input) {
    const bytes = buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
};

/** session-title normalizeSessionTitle. */
const normalizeSessionTitle = (input, maxBytes) => truncateTitleUtf8(
  cleanTitleText(input), maxBytes).trimEnd();

/** session/rename: normalize one user title and append the durable
 * `session/title` event (commands.rename → SessionTitleService.rename at
 * the pin, narrowed: this host runs no automatic title generation, so the
 * rename only pins — there is no in-flight generation to supersede). */
export const makeSessionRenameHandlers = (ctx) => ({
  'session/rename': async (args) => {
    const request = args?.request ?? args ?? {};
    if (request === null || typeof request !== 'object'
      || typeof request.sessionId !== 'string'
      || typeof request.title !== 'string') {
      throw remoteError('gateway/bad-request',
        'rename request needs sessionId and title', {});
    }
    const agent = liveAgent(ctx, request.sessionId);
    const normalized = normalizeSessionTitle(request.title, TITLE_MAX_BYTES);
    if (normalized.length === 0) {
      throw remoteError('session/title-invalid',
        'session title must contain visible characters',
        { sessionId: request.sessionId });
    }
    const event = agent.session.append('session/title', {
      title: normalized,
      messageSeqs: [],
      source: { kind: 'user' },
    });
    return { title: normalized, seq: event.seq };
  },
});

//#endregion

//#region session/updateQueue — commands.updateQueue at the pin

/** commands.ts hasPromptContent, narrowed to the queue-edit wire shape:
 * non-whitespace text (edits refuse non-text blocks before this runs). */
const hasEditText = (content) => Array.isArray(content) && content.some(
  (block) => block?.type === 'text' && typeof block.text === 'string'
    && block.text.trim() !== '');

/** The request envelope validation (shape + the edit-action content
 * rules, upstream commands.updateQueue's admission half). */
const validateQueueRequest = (request) => {
  if (request === null || typeof request !== 'object'
    || typeof request.sessionId !== 'string'
    || typeof request.itemId !== 'string'
    || request.action === null || typeof request.action !== 'object') {
    throw remoteError('gateway/bad-request',
      'updateQueue request needs sessionId, itemId, and action', {});
  }
  if (request.action.kind !== 'edit') return;
  const content = request.action.content;
  if (!Array.isArray(content)) {
    throw remoteError('gateway/bad-request',
      'queue edit action needs content blocks', {});
  }
  if (content.some((block) => block?.type !== 'text')) {
    throw remoteError('session/attachment-invalid',
      'queue edits accept text content only',
      { reason: 'QUEUE_EDIT_NON_TEXT' });
  }
  if (!hasEditText(content)) {
    throw remoteError('gateway/bad-request',
      'queue edit content must include non-whitespace text', {});
  }
};

/** Locate one pending identity across the two inbox lists (the controller's
 * locate walk); undefined when the item is no longer pending. */
const locateQueueItem = (agent, itemId) => {
  const inbox = agent.inbox;
  const nextTurn = inbox.nextTurn.find((m) => m.id === itemId);
  if (nextTurn !== undefined) return { target: 'next-turn', message: nextTurn };
  const nextStep = inbox.nextStep.find((m) => m.id === itemId);
  return nextStep === undefined
    ? undefined : { target: 'next-step', message: nextStep };
};

/** Apply one validated action to the located occurrence (the controller's
 * switch, verbatim shapes). */
const applyQueueAction = (agent, request, located) => {
  const inbox = agent.inbox;
  switch (request.action.kind) {
    case 'edit':
      inbox.replace(request.itemId, freezeMessage({
        ...located.message,
        content: [...request.action.content],
      }));
      return;
    case 'remove':
      inbox.remove(request.itemId);
      return;
    case 'steer':
      inbox.remove(request.itemId);
      agent.steer(located.message);
      return;
    default:
      throw remoteError('gateway/bad-request',
        'updateQueue action must be edit, remove, or steer', {});
  }
};

/** session/updateQueue: one pending inbox occurrence edited, removed, or
 * promoted to the running turn's step boundary (commands.updateQueue at
 * the pin). The desktop leg's subagent-ownership guard is deliberately
 * absent — the mobile profile attaches no subagent-owned sessions. */
export const makeSessionQueueHandlers = (ctx) => ({
  'session/updateQueue': async (args) => {
    const request = args?.request ?? args ?? {};
    validateQueueRequest(request);
    // An unknown session has no pending item — the upstream controller's
    // own mapping for a cold-resolve failure (session/queue-item-not-found).
    const agent = ctx.agents.get(request.sessionId);
    if (agent === undefined) {
      throw remoteError('session/queue-item-not-found',
        'queued item is no longer pending', { itemId: request.itemId });
    }
    const located = locateQueueItem(agent, request.itemId);
    if (located === undefined) {
      throw remoteError('session/queue-item-not-found',
        'queued item is no longer pending', { itemId: request.itemId });
    }
    if (request.action.kind === 'steer'
      && (located.target !== 'next-turn' || agent.status !== 'running')) {
      throw remoteError('session/steer-unavailable',
        'current turn no longer accepts steering', { itemId: request.itemId });
    }
    applyQueueAction(agent, request, located);
    return { accepted: true };
  },
});

//#endregion

//#region session/canOpenWorkspacePath — the desktop-opener gate

/** session/canOpenWorkspacePath (session-controller index.ts at the pin):
 * whether this deployment can hand a workspace path to a native desktop.
 * This host has no native opener — false, so the page hides the asker and
 * session/openWorkspacePath stays honestly unclaimed. */
export const makeSessionOpenerHandlers = () => ({
  'session/canOpenWorkspacePath': async () => false,
});

//#endregion
