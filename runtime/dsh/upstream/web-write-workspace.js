// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-workspace.js — the workspace COVERAGE adapters
 * (decision D9, api-full-coverage work stream): the workspace sidebar's
 * mutations (create/rename/delete/insertBefore/insertSessionBefore) and the
 * archive set (archiveSession/unarchiveSession), answered over the write
 * surface's in-memory workspace registry (the SAME `workspaces` map the
 * workspace/follow baseline and session attaches read). Semantics mirror the
 * upstream host commands at the pin (packages/api/workspace-controller/src/
 * commands.ts): the same wire codes, DOM-insertBefore order semantics, the
 * idempotent unarchive — and every mutation publishes its follow increment
 * (upsert/remove/order/archived) to the open workspace/follow streams. The
 * registry staying in-memory is the documented mobile shape ("no durable
 * registry", upstream/web-write-streams.js).
 */
import { remoteError } from 'upstream/web-write.js';

/** The fresh wire view of one registry row (never the live object). */
const viewOf = (workspace) => ({
  ...workspace,
  sessionIds: [...workspace.sessionIds],
});

/** The registry row for one id, or the upstream not-found refusal. */
const demandWorkspace = (deps, workspaceId) => {
  const workspace = deps.workspaces.get(workspaceId);
  if (workspace === undefined) {
    throw remoteError('workspace/not-found',
      `Workspace "${workspaceId}" not found`, { workspaceId });
  }
  return workspace;
};

/** Rebuild the registry map in one new id order (Map iteration order IS the
 * registry order the baseline reports). */
const reorderWorkspaces = (deps, ids) => {
  const rows = [...deps.workspaces.values()];
  deps.workspaces.clear();
  for (const id of ids) {
    const row = rows.find((candidate) => candidate.workspaceId === id);
    if (row !== undefined) deps.workspaces.set(id, row);
  }
};

/** Touch `updatedAt`, publish the upsert increment, return the view. */
const changed = (deps, workspace) => {
  workspace.updatedAt = new Date().toISOString();
  deps.publish({ type: 'upsert', workspace: viewOf(workspace) });
  return { workspace: viewOf(workspace) };
};

/** Create-or-adopt over an EXISTING directory (upstream create): the world
 * fact decides — a path with no directory behind it is invalid-path. */
const workspaceCreate = (ctx, deps) => async (args) => {
  const path = args?.request?.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw remoteError('gateway/bad-request', 'workspace.create requires a path', {});
  }
  const existing = [...deps.workspaces.values()]
    .find((workspace) => workspace.path === path);
  if (existing !== undefined) {
    return { workspace: viewOf(existing), created: false };
  }
  if (!await directoryExists(ctx, deps, path)) {
    throw remoteError('workspace/invalid-path',
      `cannot create a Workspace at "${path}": no directory is mounted there`,
      { path });
  }
  const now = new Date().toISOString();
  const workspace = {
    workspaceId: deps.mintId(),
    path,
    title: path.slice(path.lastIndexOf('/') + 1) || path,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  };
  deps.workspaces.set(workspace.workspaceId, workspace);
  deps.publish({ type: 'upsert', workspace: viewOf(workspace) });
  return { workspace: viewOf(workspace), created: true };
};

/** The world fact behind workspace/create: is `path` a directory of the
 * mounted world (through the vendored fs service, or the bare root)? */
const directoryExists = async (ctx, deps, path) => {
  const fs = ctx.get('fs');
  if (fs === undefined) return path === deps.root;
  const target = await fs.resolve(path).catch(() => undefined);
  const info = target === undefined ? undefined : await fs.stat(target);
  return info?.type === 'directory';
};

/** Rename after serializing title ownership checks (upstream rename). */
const workspaceRename = (ctx, deps) => async (args) => {
  const title = String(args?.request?.title ?? '').trim();
  if (title === '') {
    throw remoteError('gateway/bad-request',
      'Workspace rename requires a non-blank title', {});
  }
  const workspace = demandWorkspace(deps, args?.request?.workspaceId);
  const taken = [...deps.workspaces.values()].some((candidate) =>
    candidate.workspaceId !== workspace.workspaceId && candidate.title === title);
  if (title !== workspace.title && taken) {
    throw remoteError('workspace/name-conflict',
      `Workspace name '${title}' is already in use`, { name: title });
  }
  workspace.title = title;
  return changed(deps, workspace);
};

/** Delete the REGISTRATION, never the directory or its sessions (upstream). */
const workspaceDelete = (ctx, deps) => async (args) => {
  const workspaceId = args?.request?.workspaceId;
  demandWorkspace(deps, workspaceId);
  deps.workspaces.delete(workspaceId);
  deps.publish({ type: 'remove', workspaceId });
  return { deleted: true };
};

/** DOM-insertBefore semantics: no anchor moves the row LAST (upstream). */
const workspaceInsertBefore = (ctx, deps) => async (args) => {
  const workspaceId = args?.request?.workspaceId;
  const beforeWorkspaceId = args?.request?.beforeWorkspaceId;
  const ids = [...deps.workspaces.keys()];
  if (!ids.includes(workspaceId)
    || (beforeWorkspaceId !== undefined && !ids.includes(beforeWorkspaceId))) {
    throw remoteError('workspace/not-found',
      `Workspace "${workspaceId}" not found`, { workspaceId });
  }
  const without = ids.filter((id) => id !== workspaceId);
  const at = beforeWorkspaceId === undefined
    ? without.length : without.indexOf(beforeWorkspaceId);
  without.splice(at, 0, workspaceId);
  reorderWorkspaces(deps, without);
  deps.publish({ type: 'order', workspaceIds: without });
  return { workspaceIds: without };
};

/** Move one accounted Session within the workspace's manual order. */
const workspaceInsertSessionBefore = (ctx, deps) => async (args) => {
  const request = args?.request ?? {};
  const workspace = demandWorkspace(deps, request.workspaceId);
  const order = [...workspace.sessionIds];
  const at = order.indexOf(request.sessionId);
  const anchorAt = request.beforeSessionId === undefined
    ? undefined : order.indexOf(request.beforeSessionId);
  if (at < 0 || (request.beforeSessionId !== undefined && anchorAt < 0)) {
    throw moveInvalid(request);
  }
  order.splice(at, 1);
  const insertAt = anchorAt === undefined
    ? order.length : order.indexOf(request.beforeSessionId);
  order.splice(insertAt, 0, request.sessionId);
  workspace.sessionIds = order;
  return changed(deps, workspace);
};

/** The upstream move-invalid refusal with its full detail triple. */
const moveInvalid = (request) => remoteError('workspace/move-invalid',
  `session "${request.sessionId}" is not in the workspace's manual order`,
  {
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    ...(request.beforeSessionId === undefined ? {}
      : { beforeSessionId: request.beforeSessionId }),
  });

/** The registry-global archive set; unknown sessions refuse (upstream's
 * WorkspaceUnknownSessionError → session/not-found). */
const workspaceArchiveSession = (ctx, deps) => async (args) => {
  const sessionId = args?.request?.sessionId;
  if (ctx.sessions.get(sessionId) === undefined) {
    throw remoteError('session/not-found',
      `session "${sessionId}" is not attached to the mobile runtime`,
      { sessionId });
  }
  if (!deps.archived.includes(sessionId)) deps.archived.push(sessionId);
  deps.publish({ type: 'archived', archivedSessionIds: [...deps.archived] });
  return { archivedSessionIds: [...deps.archived] };
};

/** Idempotent unarchive: an id that is not archived is not an error. */
const workspaceUnarchiveSession = (ctx, deps) => async (args) => {
  const sessionId = args?.request?.sessionId;
  const at = deps.archived.indexOf(sessionId);
  if (at >= 0) deps.archived.splice(at, 1);
  deps.publish({ type: 'archived', archivedSessionIds: [...deps.archived] });
  return { archivedSessionIds: [...deps.archived] };
};

/** The mutations, keyed by wire name (args = the wire args object). */
export const makeWorkspaceHandlers = (ctx, deps) => ({
  'workspace/create': workspaceCreate(ctx, deps),
  'workspace/rename': workspaceRename(ctx, deps),
  'workspace/delete': workspaceDelete(ctx, deps),
  'workspace/insertBefore': workspaceInsertBefore(ctx, deps),
  'workspace/insertSessionBefore': workspaceInsertSessionBefore(ctx, deps),
  'workspace/archiveSession': workspaceArchiveSession(ctx, deps),
  'workspace/unarchiveSession': workspaceUnarchiveSession(ctx, deps),
});
