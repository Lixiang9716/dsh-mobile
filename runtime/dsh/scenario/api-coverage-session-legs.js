// dsh:logging-exempt (probe: its verdict output IS the product)
/** api-coverage-session-legs.js — the session deep-page legs phase,
 * split from api-coverage-probe.js at the code-size gate (the
 * manager-legs-probe shape: the probe's helpers ride in as deps). It
 * drives the five claimed legs over the live journal — rename, page,
 * search, the queue mutations — plus the honest refusals the narrowing
 * keeps (fork-unavailable with no completed turn, steer on an idle agent,
 * unknown queue items, invalid titles and queries) and the opener gate +
 * the empty preset catalog.
 */

/** The rename legs: the accepted title lands as the durable session/title
 * event; a TERMINATED OSC sequence strips whole (the session-title
 * normalize contract at the pin), a blank title refuses. */
const renameLegs = async ({ api, demand, demandRefusal, session, SESSION_ID }) => {
  const renamed = await api['session/rename'](
    { request: { sessionId: SESSION_ID, title: '  probe \u001B]0;esc\u0007  title' } });
  demand(renamed.title === 'probe title'
    && session.snapshotEvents()[renamed.seq]?.type === 'session/title'
    && session.snapshotEvents()[renamed.seq].data.title === 'probe title',
    `rename: ${JSON.stringify(renamed)}`);
  await demandRefusal(api['session/rename'],
    { request: { sessionId: SESSION_ID, title: '   ' } },
    'session/title-invalid', 'blank title');
  return renamed;
};

/** The page legs: the journal up to the staged message, the empty
 * below-log page, one message-aligned backward window, and the cursor +
 * address refusals. */
const pageLegs = async ({ api, demand, demandRefusal, session, SESSION_ID, staged }) => {
  const full = await api['session/page'](
    { request: { address: { kind: 'session', sessionId: SESSION_ID },
      throughSeq: staged.seq } });
  demand(full.records.length === session.seq && full.hasMore === false
    && full.records[full.records.length - 1].event.seq === staged.seq,
    `page full: ${full.records.length} records, hasMore ${full.hasMore}`);
  const belowLog = await api['session/page'](
    { request: { address: { kind: 'session', sessionId: SESSION_ID }, throughSeq: -1 } });
  demand(belowLog.records.length === 0 && belowLog.hasMore === false,
    `page throughSeq -1 is the empty below-log page: ${JSON.stringify(belowLog)}`);
  const windowed = await api['session/page'](
    { request: { address: { kind: 'session', sessionId: SESSION_ID },
      throughSeq: staged.seq, maxMessages: 1 } });
  demand(windowed.records.length === 1
    && windowed.records[0].event.seq === staged.seq
    && windowed.records[0].event.type === 'user/message'
    && windowed.hasMore === true,
    `page window: ${JSON.stringify(windowed).slice(0, 200)}`);
  await demandRefusal(api['session/page'],
    { request: { address: { kind: 'session', sessionId: SESSION_ID },
      throughSeq: session.seq } },
    'gateway/bad-request', 'throughSeq past cursor');
  await demandRefusal(api['session/page'],
    { request: { address: { kind: 'subagent', parentSessionId: SESSION_ID,
      childSessionId: 'session-none', mode: 'one-shot' }, throughSeq: -1 } },
    'subagent/not-found', 'subagent address');
  return full;
};

/** The search legs: a case-insensitive hit over the staged message with a
 * bounded snippet, a miss, and the empty-query refusal. */
const searchLegs = async ({ api, demand, demandRefusal, SESSION_ID }) => {
  const found = await api['session/search']({ request: { query: 'search NEEDLE' } });
  demand(Array.isArray(found.items) && found.items.length === 1
    && found.items[0].sessionId === SESSION_ID
    && found.items[0].snippet.includes('SEARCH needle')
    && found.items[0].snippet.length <= 244
    && found.hasMore === false,
    `search: ${JSON.stringify(found).slice(0, 200)}`);
  const empty = await api['session/search']({ request: { query: 'absent text' } });
  demand(empty.items.length === 0 && empty.hasMore === false, 'search miss');
  await demandRefusal(api['session/search'], { request: { query: '  ' } },
    'gateway/bad-request', 'empty query');
  return found;
};

/** The queue legs: an injected pending item edits (identity preserved),
 * refuses non-text edits, refuses an idle steer, and removes; an unknown
 * item refuses with the upstream code. */
const queueLegs = async ({ api, demand, demandRefusal, agent, SESSION_ID, createUserMessage }) => {
  const queued = createUserMessage({
    content: [{ type: 'text', text: 'queued before edit' }],
    source: { kind: 'user' },
  });
  agent.inject(queued);
  const itemId = agent.inbox.nextStep[0].id;
  const edited = await api['session/updateQueue'](
    { request: { sessionId: SESSION_ID, itemId,
      action: { kind: 'edit', content: [{ type: 'text', text: 'queued after edit' }] } } });
  demand(edited.accepted === true
    && agent.inbox.nextStep[0].content[0].text === 'queued after edit'
    && agent.inbox.nextStep[0].id === itemId,
    `queue edit: ${JSON.stringify(edited)}`);
  await demandRefusal(api['session/updateQueue'],
    { request: { sessionId: SESSION_ID, itemId,
      action: { kind: 'edit', content: [
        { type: 'text', text: 'keep' }, { type: 'image', attachment: {} }] } } },
    'session/attachment-invalid', 'non-text queue edit');
  await demandRefusal(api['session/updateQueue'],
    { request: { sessionId: SESSION_ID, itemId,
      action: { kind: 'steer' } } },
    'session/steer-unavailable', 'steer on an idle agent');
  const removed = await api['session/updateQueue'](
    { request: { sessionId: SESSION_ID, itemId, action: { kind: 'remove' } } });
  demand(removed.accepted === true && agent.inbox.nextStep.length === 0,
    `queue remove: ${JSON.stringify(removed)}`);
  await demandRefusal(api['session/updateQueue'],
    { request: { sessionId: SESSION_ID, itemId: 'message-none',
      action: { kind: 'remove' } } },
    'session/queue-item-not-found', 'unknown queue item');
  // Fork stays claimed but refuses honestly with no completed turn.
  await demandRefusal(api['session/fork'],
    { request: { sessionId: SESSION_ID } },
    'session/fork-unavailable', 'fork with no completed turn');
  return removed;
};

/** The gate legs: the desktop-opener gate answers false and the preset
 * catalog answers the honest empty table. */
const gateLegs = async ({ api, demand }) => {
  const canOpen = await api['session/canOpenWorkspacePath']({});
  demand(canOpen === false, `canOpenWorkspacePath: ${JSON.stringify(canOpen)}`);
  const catalog = await api['permissionPresets/catalog']({});
  demand(catalog !== null && typeof catalog === 'object'
    && Array.isArray(catalog.options) && catalog.options.length === 0,
    `permissionPresets/catalog: ${JSON.stringify(catalog)}`);
};

/** The subagent legs (upstream/web-write-subagents.js), over the REAL
 * vendored runtime boot.js mounts: the catalog answers the honest empty
 * roster for a live parent, a prompt to an address with no live child
 * refuses with the service's own structured code, and interruptByParent
 * accepts absent targets as no-ops (the upstream contract). */
const subagentLegs = async ({ ctx, api, demand, demandRefusal, SESSION_ID }) => {
  const list = await api['subagents/list']({ parentSessionId: SESSION_ID });
  demand(list !== null && typeof list === 'object'
    && Array.isArray(list.entries) && list.entries.length === 0
    && list.parentAvailable === true,
    `subagents/list: ${JSON.stringify(list).slice(0, 200)}`);
  await demandRefusal(api['subagents/prompt'],
    { request: { requestId: 'probe-subagent-1', parentSessionId: SESSION_ID,
      childSessionId: 'session-none', mode: 'continuable',
      delivery: 'queue',
      content: [{ type: 'text', text: 'anyone home?' }] } },
    'subagent/not-resumable', 'prompt to a childless address');
  const interrupted = await api['subagents/interruptByParent'](
    { childSessionId: 'session-none', parentSessionId: SESSION_ID,
      mode: 'continuable' });
  demand(interrupted.accepted === true,
    `subagents/interruptByParent: ${JSON.stringify(interrupted)}`);
  const cold = await api['subagents/list']({ parentSessionId: 'session-none' });
  demand(cold.parentAvailable === false,
    `subagents/list cold parent: ${JSON.stringify(cold)}`);
};

/** The phase driver (the probe passes its helpers in as deps). */
export const probeSessionLegs = async ({ ctx, api, demand, demandRefusal, log, SESSION_ID }) => {
  const agent = ctx.agents.get(SESSION_ID);
  const session = ctx.sessions.get(SESSION_ID);
  const renamed = await renameLegs({ api, demand, demandRefusal, session, SESSION_ID });
  // Stage one real surface message (the exact append the prompt admission
  // commits) so the pager's message-aligned cut and the search corpus have
  // a message to align on.
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const message = createUserMessage({
    content: [{ type: 'text', text: 'the coverage probe SEARCH needle' }],
    source: { kind: 'user' },
  });
  const staged = session.append('user/message', message, { surfaceOp: 'append' });
  const full = await pageLegs({ api, demand, demandRefusal, session, SESSION_ID, staged });
  const found = await searchLegs({ api, demand, demandRefusal, SESSION_ID });
  const removed = await queueLegs({ api, demand, demandRefusal, agent, SESSION_ID,
    createUserMessage });
  await subagentLegs({ ctx, api, demand, demandRefusal, SESSION_ID });
  gateLegs({ api, demand });
  log.info('session legs ok', {
    renamed: renamed.title, paged: full.records.length,
    searchHit: found.items.length, queueAccepted: removed.accepted === true,
  });
};
