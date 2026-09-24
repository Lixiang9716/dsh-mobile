// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-streams.js — the WRITE SURFACE's mux streams (decision
 * D9, W-RPC leg): the follow feeds the official page attaches while it
 * drives a turn. Everything here answers from the REAL vendored spine on
 * the SAME ctx; anything not implemented stays structured-unavailable.
 *
 * Upstream semantics mirrored from source at the pin:
 *   - session/follow (history.follow): snapshot {header, cursor, records,
 *     hasMore, projections, assistantStream} then gap-free seq events and
 *     assistant-stream notification frames with monotonic revisions;
 *     cursor = -1 when the log is empty.
 *   - workspace/follow (workspace-controller feed): baseline {items,
 *     archivedSessionIds} then upsert increments; one REAL seeded workspace
 *     over the profile container root (mobile-honest: no durable registry).
 *   - session/control: the opening baseline (empty jobs + projections — the
 *     UI folds state from the REAL journal streams).
 *   - $events: the gateway-internal forwarded-event stream's `ready`
 *     handshake; the mobile profile forwards no gateway-internal events.
 */
import { mintUUID } from 'upstream/web-write.js';

/** upstream history cursorBeforeNext: the durable cursor before `nextSeq`. */
const cursorBeforeNext = (nextSeq) => (nextSeq === 0 ? -1 : nextSeq - 1);

/** One wire event record: SessionEventEntry. The envelope passes through the
 * event-local metadata the official client validates (`ignorable`,
 * `sourceEventSeqs`, and the `surfaceOp` marker the four surface-eligible
 * message events REQUIRE — dropping it fails the page's history load). */
export const wireEvent = (event) => ({
  type: 'event',
  event: {
    type: event.type, seq: event.seq, time: event.time ?? 0,
    data: event.data ?? {},
    ...(event.ignorable === true ? { ignorable: true } : {}),
    ...(event.sourceEventSeqs === undefined ? {} :
      { sourceEventSeqs: event.sourceEventSeqs }),
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
  },
});

/** upstream history.wireAssistantStreamFrame: stamp `startedAfterSeq` on
 * start frames; chunk/end frames are already wire-shaped. */
const wireAssistantFrame = (frame, durableCursor) => {
  if (frame.type === 'start') return { ...frame, startedAfterSeq: durableCursor };
  return { ...frame };
};

/** The session header the wire snapshot carries (upstream wireHeader). */
const wireHeader = (session) => ({
  version: session.header?.version ?? 3,
  id: session.id,
  createdAt: session.header?.createdAt ?? 0,
  ...(session.header?.cwd === undefined ? {} : { cwd: session.header.cwd }),
  isSeeded: session.header?.isSeeded ?? false,
});

/** Per-session assistant-stream continuity (revision + open attempt). */
const stateFor = (assistantState, sessionId) => {
  let state = assistantState.get(sessionId);
  if (state === undefined) {
    state = { revision: 0, active: null };
    assistantState.set(sessionId, state);
  }
  return state;
};

/** Fold one live agent frame into the session's continuity state. */
const trackAssistant = (state, frame, agent) => {
  state.revision = frame.revision;
  if (frame.type === 'start') {
    state.active = {
      attemptId: frame.attemptId,
      turn: frame.turn,
      step: frame.step,
      startedAfterSeq: cursorBeforeNext(agent.session.seq),
      chunks: [],
    };
  } else if (frame.type === 'chunk' && state.active !== null
    && state.active.attemptId === frame.attemptId) {
    state.active.chunks.push({ chunk: frame.chunk });
  } else if (frame.type === 'end' && state.active !== null
    && state.active.attemptId === frame.attemptId) {
    state.active = null;
  }
};

/** The opening snapshot frame (upstream history.follow): the whole log;
 * pagination never triggers at the mobile bound (page stays unclaimed). */
const followSnapshot = (ctx, assistantState, sessionId) => {
  const session = ctx.sessions.get(sessionId);
  const records = session.snapshotEvents().map((event) => wireEvent(event));
  const cursor = records.length > 0
    ? records[records.length - 1].event.seq : -1;
  const state = stateFor(assistantState, sessionId);
  return {
    type: 'snapshot',
    header: wireHeader(session),
    cursor,
    records,
    hasMore: false,
    projections: { asOfSeq: cursor, values: {} },
    assistantStream: state.active === null
      ? { revision: state.revision }
      : {
        revision: state.revision,
        activeAttempt: {
          attemptId: state.active.attemptId,
          startedAfterSeq: state.active.startedAfterSeq,
          turn: state.active.turn,
          step: state.active.step,
          nextIndex: state.active.chunks.length,
          stream: state.active.chunks.map((chunk) => chunk.chunk),
        },
      },
  };
};

/** A stateless feed: one opening frame, then hold the stream open. */
const openFeed = (post, followStreams, msg, kind, opening) => {
  post({ type: 'mux.item', streamId: msg.streamId, value: opening });
  followStreams.set(msg.streamId, { kind, unsubscribe: () => {} });
  return { kind: 'attached', endpoint: msg.endpoint };
};

/** The session/follow open: resolve the addressed session, demand the opted-
 * in assistant baseline, snapshot, then forward live events. The payload
 * carries the follow request under `args` — the same
 * `{args: {request: …}}` envelope the unary RPCs use. */
const openFollow = (ctx, post, followStreams, assistantState, msg) => {
  const payload = msg.payload ?? {};
  const request = payload.args?.request ?? payload.args ?? payload ?? {};
  const address = request.address ?? {};
  const sessionId = address.sessionId ?? request.sessionId;
  const session = sessionId !== undefined
    ? ctx.sessions.get(sessionId) : undefined;
  if (session === undefined) {
    return rejectFollow(post, msg, sessionId);
  }
  if (request.assistantStream !== true) {
    // The official client always opts in; without the opted-in baseline its
    // revision continuity cannot hold — reject loudly, never half-serve.
    post({
      type: 'mux.error', streamId: msg.streamId,
      code: 'gateway/unimplemented',
      message: 'session/follow requires assistantStream:true',
      details: {},
    });
    return { kind: 'error' };
  }
  post({
    type: 'mux.item', streamId: msg.streamId,
    value: followSnapshot(ctx, assistantState, sessionId),
  });
  const unsubscribe = ctx.on('session/event', (updated, event) => {
    if (updated?.id !== sessionId || event === undefined) return;
    post({ type: 'mux.item', streamId: msg.streamId, value: wireEvent(event) });
  });
  followStreams.set(msg.streamId, { kind: 'session', sessionId, unsubscribe });
  return { kind: 'attached', endpoint: msg.endpoint };
};

/** The structured error frame for a follow open naming an unattached
 * session (fail loud with the offending identity, never a silent hang). */
const rejectFollow = (post, msg, sessionId) => {
  post({
    type: 'mux.error', streamId: msg.streamId, code: 'gateway/unavailable',
    message: `session ${JSON.stringify(sessionId ?? null)} is not attached`
      + ' to the mobile runtime',
    details: { endpoint: msg.endpoint, sessionId: sessionId ?? null },
  });
  return { kind: 'error' };
};

/** The coverage stream open leg: one extra endpoint's open through the
 * coverage plane. The wrapped msg lets the leg attach its unsubscribe into
 * the registry entry and poll whether the stream was cancelled already.
 * Unknown endpoints answer null (the caller's unimplemented leg). */
const openCoverage = (post, followStreams, coverage, msg) => {
  if (coverage?.open === undefined) return null;
  let unsubscribe = () => {};
  const outcome = coverage.open({
    ...msg,
    cancelled: () => followStreams.get(msg.streamId) === undefined,
    attachUnsubscribe: (fn) => { unsubscribe = fn; },
  });
  if (outcome !== undefined && outcome.kind === 'attached') {
    followStreams.set(msg.streamId, {
      kind: 'coverage',
      unsubscribe: () => unsubscribe(),
    });
  }
  return outcome ?? null;
};

/** Cancel one coverage-registered stream by id; unknown ids answer
 * undefined so the caller's base journal map handles them (the
 * pre-coverage behavior). */
const cancelCoverage = (post, followStreams, msg) => {
  const stream = followStreams.get(msg.streamId);
  if (stream === undefined || stream.kind !== 'coverage') return undefined;
  followStreams.delete(msg.streamId);
  stream.unsubscribe();
  post({ type: 'mux.end', streamId: msg.streamId });
  return { kind: 'cancelled' };
};

/**
 * The mux feeds for one write surface. `workspaces` is the surface's
 * workspace registry (Map workspaceId → workspace): the workspace feed's
 * baseline reads it and `attachWorkspace` publishes upserts to every open
 * feed. `coverage` (optional, the api-full-coverage plane) carries:
 *   - archived() — the archive set the workspace baseline reports;
 *   - open(msg) — one extra stream endpoint's open leg (workspaceFiles/
 *     changes); it may attach its unsubscribe through the wrapped msg and
 *     poll msg.cancelled().
 * @returns {openStream, cancel, attachWorkspace, publish, dispose}
 */
export const createFollowStreams = (ctx, post, root, workspaces, coverage) => {
  const followStreams = new Map();
  const assistantState = new Map();

  // Assistant frames fold into state EVEN with no follower attached (a
  // later snapshot must report the true revision), then fan out live.
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = agent?.session?.id;
    if (sessionId === undefined) return;
    trackAssistant(stateFor(assistantState, sessionId), frame, agent);
    fanAssistant(post, followStreams, agent, frame, sessionId);
  });

  const openStream = (msg) => {
    if (msg.endpoint === 'session/follow') {
      return openFollow(ctx, post, followStreams, assistantState, msg);
    }
    const opening = openingFor(workspaces, root, msg.endpoint, coverage);
    if (opening !== undefined) {
      return openFeed(post, followStreams, msg, opening.kind, opening.value);
    }
    return openCoverage(post, followStreams, coverage, msg);
  };

  const cancel = (msg) => cancelCoverage(post, followStreams, msg);

  const dispose = () => {
    for (const [, stream] of followStreams) {
      if (typeof stream.unsubscribe === 'function') stream.unsubscribe();
    }
    followStreams.clear();
  };

  return {
    openStream,
    cancel,
    attachWorkspace: (workspace, sessionId) => {
      publishUpsert(post, followStreams, workspace, sessionId);
    },
    /** One workspace/follow increment (upsert/remove/order/archived) fanned
     * to every open workspace feed — the workspace mutations' channel. */
    publish: (increment) => {
      for (const [streamId, stream] of followStreams) {
        if (stream.kind !== 'workspace') continue;
        post({ type: 'mux.item', streamId, value: increment });
      }
    },
    dispose,
  };
};

/** The opening frame of each stateless feed, by endpoint: the workspace
 * baseline over the live registry, the session control baseline (empty
 * jobs + projections — the UI folds state from the REAL journal streams),
 * and the `$events` ready handshake (the mobile profile forwards no
 * gateway-internal Cordis events). */
const workspaceBaseline = (workspaces, coverage) => ({
  type: 'baseline',
  value: {
    items: [...workspaces.values()].map((ws) => (
      { ...ws, sessionIds: [...ws.sessionIds] })),
    archivedSessionIds: [...(coverage?.archived?.() ?? [])],
  },
});

const openingFor = (workspaces, root, endpoint, coverage) => {
  if (endpoint === 'workspace/follow') {
    return { kind: 'workspace', value: workspaceBaseline(workspaces, coverage) };
  }
  if (endpoint === 'session/control') {
    return {
      kind: 'control',
      value: { type: 'baseline', value: { jobs: {}, projections: {} } },
    };
  }
  if (endpoint === '$events') {
    return {
      kind: 'events',
      value: { type: 'ready', clientId: mintUUID(), host: { home: root } },
    };
  }
  return undefined;
};

/** Fan one assistant frame out to every open session/follow stream of the
 * frame's session. */
const fanAssistant = (post, followStreams, agent, frame, sessionId) => {
  for (const [streamId, stream] of followStreams) {
    if (stream.kind !== 'session' || stream.sessionId !== sessionId) continue;
    post({
      type: 'mux.item', streamId,
      value: {
        type: 'assistant-stream',
        frame: wireAssistantFrame(frame, cursorBeforeNext(agent.session.seq)),
      },
    });
  }
};

/** Insert the session into its workspace's manual order and publish the
 * upsert increment to every open workspace/follow stream. */
const publishUpsert = (post, followStreams, workspace, sessionId) => {
  if (workspace === undefined || workspace.sessionIds.includes(sessionId)) {
    return;
  }
  workspace.sessionIds = [...workspace.sessionIds, sessionId];
  workspace.updatedAt = new Date().toISOString();
  for (const [streamId, stream] of followStreams) {
    if (stream.kind !== 'workspace') continue;
    post({
      type: 'mux.item', streamId,
      value: {
        type: 'upsert',
        workspace: { ...workspace, sessionIds: [...workspace.sessionIds] },
      },
    });
  }
};
