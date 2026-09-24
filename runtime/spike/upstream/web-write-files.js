// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-files.js — the workspaceFiles COVERAGE adapters
 * (decision D9, api-full-coverage work stream): the read family and the
 * `fs/observed` change feed the official page's file sidebar and preview
 * read, answered from the REAL vendored `fs` service (dsh-fs-local) over the
 * pinned workspace world. Semantics mirror the upstream host service at the
 * pin (packages/api/workspace-files/src/index.ts): the same caps, the same
 * workspace-file/* error vocabulary, page cutting over streamText. One
 * narrowing is a platform fact, not a behavior change: the mobile world is
 * ONE in-memory root (mountWorkspace, no symlinks) — a path outside the
 * pinned root names NO entry, so the read family answers not-found where the
 * desktop would read a host file, and listings answer outside-workspace via
 * the same vocabulary the upstream confine uses.
 */
import { remoteError } from 'upstream/web-write.js';
import { lexical } from 'upstream/shims/fs-workspace.js';
import { resolve as pathResolve, dirname as pathDirname } from 'node:path';

/** Upstream WorkspaceFiles.Config defaults (packages/api/workspace-files). */
export const FILE_CAPS = {
  maxBytes: 2 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxLines: 5000,
  maxEntries: 2000,
};

/** The byte text never carries: its presence marks a page as binary. */
const NUL = String.fromCharCode(0);

/** Refuse anything the wire schema admits as a number but a window cannot
 * use: only safe integers index a file (upstream integerAtLeast). */
const integerAtLeast = (value, min, name) => {
  if (!Number.isSafeInteger(value) || value < min) {
    throw remoteError('gateway/bad-request',
      `${name} must be a safe integer of at least ${min}`, {});
  }
  return value;
};

/** The vendored fs service, or a loud refusal (errorOf maps the triple). */
const demandFs = (ctx) => {
  const fs = ctx.get('fs');
  if (fs === undefined) {
    throw remoteError('gateway/unavailable', 'no fs service is mounted', {});
  }
  return fs;
};

/** The workspace root a scope's Session names (its header cwd), or the
 * profile container root when the header carries none. An unknown session is
 * the upstream lookup failure, spelled session/not-found. */
export const scopeRootOf = (ctx, deps, scopeId) => {
  const header = ctx.sessions.get(String(scopeId))?.header;
  const root = header?.cwd ?? deps.root;
  if (typeof root !== 'string' || !root.startsWith('/')) {
    throw remoteError('gateway/unavailable',
      `workspace scope ${JSON.stringify(scopeId ?? null)} names no root`, {});
  }
  return root;
};

/** The scope root for one wire workspaceFileScopeId — the change feed's
 * open leg resolves it exactly as the read family does. */
export const resolveScopeRoot = (ctx, deps, scopeId) => scopeRootOf(ctx, deps, scopeId);

/** The absolute lexical form of `path` against `root`, and whether it stays
 * inside the pinned world root (the mobile containment fact). */
const lexicalUnder = (root, path) => {
  const absolute = path.startsWith('/') ? lexical(path) : lexical(`${root}/${path}`);
  return { absolute, under: absolute === root || absolute.startsWith(`${root}/`) };
};

/** Apply the page defaults and caps (upstream resolvePage). */
const resolvePage = (range) => {
  const offset = range?.offset === undefined ? 1 : integerAtLeast(range.offset, 1, 'offset');
  const limit = range?.limit === undefined ? FILE_CAPS.maxLines
    : integerAtLeast(range.limit, 1, 'limit');
  if (limit > FILE_CAPS.maxLines) {
    throw remoteError('gateway/bad-request',
      `limit must be at most ${FILE_CAPS.maxLines}`, {});
  }
  return { offset, limit };
};

/** Apply the byte-window defaults and cap; a window above the cap is
 * refused, not shortened (upstream resolveWindow). */
const resolveWindow = (range, path) => {
  const offset = range?.offset === undefined ? 0 : integerAtLeast(range.offset, 0, 'offset');
  const length = range?.length === undefined ? FILE_CAPS.maxBytes
    : integerAtLeast(range.length, 1, 'length');
  if (offset + length > Number.MAX_SAFE_INTEGER) {
    throw remoteError('gateway/bad-request',
      'offset plus length must stay a safe integer', {});
  }
  if (length > FILE_CAPS.maxBytes) {
    throw remoteError('workspace-file/too-large',
      `${length} bytes of "${path}" exceed the ${FILE_CAPS.maxBytes} byte cap`,
      { path, limit: FILE_CAPS.maxBytes });
  }
  return { offset, length };
};

/** All gates for a regular file, ending in the one stat that names its
 * version and size (upstream locateFile, over lexical world paths). */
const locateFile = async (fs, root, absolute, path) => {
  const entry = await fs.lstat(absolute, { cwd: root });
  if (entry === undefined) {
    throw remoteError('workspace-file/not-found', `no entry at "${path}"`, { path });
  }
  if (entry.type !== 'file') {
    throw remoteError('workspace-file/not-regular-file',
      `"${path}" is a ${entry.type}`, { path, kind: entry.type });
  }
  const target = await fs.resolve(absolute);
  const info = await fs.stat(target);
  if (info === undefined) {
    throw remoteError('workspace-file/not-found', `no entry at "${path}"`, { path });
  }
  if (info.type !== 'file') {
    throw remoteError('workspace-file/not-regular-file',
      `"${path}" is a ${info.type}`, { path, kind: info.type });
  }
  return { target, info };
};

/** The wire WorkspaceFileStat triple (upstream statOf). */
const statOf = (fs, target, info) => ({
  absolutePath: fs.processPath(target),
  version: info.version,
  ...(info.size === undefined ? {} : { bytes: info.size }),
});

/** The backend's non-text refusal, recognized by its code alone. */
const isNotTextRefusal = (error) => (
  typeof error === 'object' && error !== null && error.code === 'FS_NOT_TEXT');

/** The backend's too-large refusal (upstream's readAll FS_TOO_LARGE catch). */
const isTooLargeRefusal = (error) => (
  typeof error === 'object' && error !== null && error.code === 'FS_TOO_LARGE');

/** Cut lines `offset` through `offset + limit - 1` from decoded chunks,
 * refusing at the byte cap mid-line (upstream cutPage, compacted). */
const cutPage = async (chunks, offset, limit, path) => {
  const last = offset + limit - 1;
  const lines = [];
  let current = '';
  let bytes = 0;
  let lineNumber = 1;
  const admit = (size) => {
    bytes += size;
    if (bytes > FILE_CAPS.maxBytes) {
      throw remoteError('workspace-file/too-large',
        `lines ${offset}-${last} of "${path}" exceed the ${FILE_CAPS.maxBytes} byte cap`,
        { path, limit: FILE_CAPS.maxBytes });
    }
  };
  for await (const chunk of chunks) {
    let position = 0;
    while (position < chunk.length) {
      if (lineNumber > last) return { text: lines.join('\n'), lines: lines.length, eof: false };
      const newline = chunk.indexOf('\n', position);
      const segment = newline === -1 ? chunk.slice(position) : chunk.slice(position, newline);
      if (lineNumber >= offset) {
        admit(globalThis.Buffer.byteLength(segment, 'utf8'));
        current += segment;
      }
      if (newline === -1) break;
      if (lineNumber >= offset) { lines.push(current); current = ''; bytes += 1; }
      lineNumber += 1;
      position = newline + 1;
    }
  }
  if (current.length > 0) { lines.push(current); }
  return { text: lines.join('\n'), lines: lines.length, eof: true };
};

/** One complete-file byte read with the upstream full-file cap, from an
 * absolute in-world path (shared by readAll and readRelated). */
const readAllFrom = async (ctx, deps, args, absolute) => {
  const fs = demandFs(ctx);
  const root = scopeRootOf(ctx, deps, args?.workspaceFileScopeId);
  const path = String(args?.path);
  const { target, info } = await locateFile(fs, root, absolute, path);
  let data;
  try {
    data = await fs.readBytes(target, undefined, FILE_CAPS.maxFileBytes);
  } catch (error) {
    if (isTooLargeRefusal(error)) {
      throw remoteError('workspace-file/too-large',
        `"${path}" exceeds the ${FILE_CAPS.maxFileBytes} byte full-file cap`,
        { path, limit: FILE_CAPS.maxFileBytes });
    }
    throw error;
  }
  return {
    ...statOf(fs, target, info), offset: 0,
    data: globalThis.Buffer.fromBytes(data).toString('base64'), eof: true,
  };
};

/** The scope context one read-family call runs against: the session's
 * workspace root, the lexical absolute path, and the world-containment fact. */
const readScope = (ctx, deps, args) => {
  const root = scopeRootOf(ctx, deps, args?.workspaceFileScopeId);
  const path = args?.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw remoteError('gateway/bad-request', 'path is required', {});
  }
  const { absolute, under } = lexicalUnder(root, path);
  return { fs: demandFs(ctx), root, path, absolute, under };
};

/** The absent-outside-world refusal: the read family reads through the
 * composed fs, and in this world nothing exists outside the pinned root. */
const demandInside = (s) => {
  if (!s.under) {
    throw remoteError('workspace-file/not-found', `no entry at "${s.path}"`,
      { path: s.path });
  }
};

/** stat: identity, version, and size without content. */
const statCall = async (ctx, deps, args) => {
  const s = readScope(ctx, deps, args);
  demandInside(s);
  const { target, info } = await locateFile(s.fs, s.root, s.absolute, s.path);
  return statOf(s.fs, target, info);
};

/** read: one page of lines, classifying the backend's non-text refusal. */
const readCall = async (ctx, deps, args) => {
  const s = readScope(ctx, deps, args);
  demandInside(s);
  const { offset, limit } = resolvePage(args?.range);
  const { target, info } = await locateFile(s.fs, s.root, s.absolute, s.path);
  let page;
  try {
    page = await cutPage(await s.fs.streamText(target), offset, limit, s.path);
  } catch (error) {
    if (isNotTextRefusal(error)) {
      throw remoteError('workspace-file/not-text', `"${s.path}" is not UTF-8 text`,
        { path: s.path });
    }
    throw error;
  }
  if (page.text.includes(NUL)) {
    throw remoteError('workspace-file/not-text', `"${s.path}" contains NUL bytes`,
      { path: s.path });
  }
  return { ...statOf(s.fs, target, info), offset, text: page.text, lines: page.lines, eof: page.eof };
};

/** readBytes: one raw byte window, no decoding and no binary rejection. */
const readBytesCall = async (ctx, deps, args) => {
  const s = readScope(ctx, deps, args);
  demandInside(s);
  const { offset, length } = resolveWindow(args?.range, s.path);
  const { target, info } = await locateFile(s.fs, s.root, s.absolute, s.path);
  const data = await s.fs.readByteRange(target, { offset, length });
  const eof = info.size === undefined
    ? data.length < length : offset + data.length >= info.size;
  return {
    ...statOf(s.fs, target, info), offset,
    data: globalThis.Buffer.fromBytes(data).toString('base64'), eof,
  };
};

/** readRelated: a complete file relative to another file's directory
 * (relative filesystem paths only). */
const readRelatedCall = async (ctx, deps, args) => {
  const s = readScope(ctx, deps, args);
  demandInside(s);
  const relative = String(args?.relativePath ?? '').replace(/\\/g, '/');
  if (relative.length === 0 || relative.startsWith('/')
    || /^[a-z][a-z\d+.-]*:/iu.test(relative) || relative.includes(NUL)) {
    throw remoteError('gateway/bad-request',
      'relativePath must be a relative filesystem path', {});
  }
  const { target } = await locateFile(s.fs, s.root, s.absolute, s.path);
  const joined = pathResolve(pathDirname(s.fs.processPath(target)), relative);
  const next = lexicalUnder(s.root, joined);
  if (!next.under) {
    throw remoteError('workspace-file/not-found', `no entry at "${joined}"`,
      { path: joined });
  }
  return readAllFrom(ctx, deps, args, next.absolute);
};

/** The read-family handlers, keyed by wire name (args = the wire args
 * object: workspaceFileScopeId + method parameters). readAll delegates to
 * readAllFrom under the same scope gate. */
export const makeWorkspaceFileHandlers = (ctx, deps) => ({
  'workspaceFiles/stat': (args) => statCall(ctx, deps, args),
  'workspaceFiles/read': (args) => readCall(ctx, deps, args),
  'workspaceFiles/readAll': async (args) => {
    const s = readScope(ctx, deps, args);
    demandInside(s);
    return readAllFrom(ctx, deps, args, s.absolute);
  },
  'workspaceFiles/readBytes': (args) => readBytesCall(ctx, deps, args),
  'workspaceFiles/readRelated': (args) => readRelatedCall(ctx, deps, args),
});

/** Directory listing over the same world (upstream workspaceFiles/list):
 * children of one workspace directory, entry-capped, truncated flagged. */
export const makeWorkspaceListHandler = (ctx, deps) => async (args) => {
  const fs = demandFs(ctx);
  const root = scopeRootOf(ctx, deps, args?.workspaceFileScopeId);
  const path = args?.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw remoteError('gateway/bad-request', 'path is required', {});
  }
  const { absolute, under } = lexicalUnder(root, path);
  if (!under) {
    throw remoteError('workspace-file/outside-workspace',
      `"${path}" is outside the workspace`, { path });
  }
  const entry = await fs.lstat(absolute, { cwd: root });
  if (entry === undefined) {
    throw remoteError('workspace-file/not-found', `no entry at "${path}"`, { path });
  }
  if (entry.type !== 'directory') {
    throw remoteError('workspace-file/not-directory',
      `"${path}" is a ${entry.type}`, { path, kind: entry.type });
  }
  const target = await fs.resolve(absolute);
  const children = await fs.listDir(target);
  return {
    path: absolute === root ? '' : absolute.slice(root.length + 1),
    entries: children.slice(0, FILE_CAPS.maxEntries).map((child) => ({
      name: child.name,
      type: child.type,
      ...(child.size === undefined ? {} : { size: child.size }),
    })),
    truncated: children.length > FILE_CAPS.maxEntries,
  };
};

/**
 * The `fs/observed` change feed (upstream WorkspaceChangeFeed, mux-shaped):
 * `follow(root, emit, isCancelled)` resolves the root, emits `ready`, drains
 * observations queued during resolution, then forwards live observations
 * inside the root as change frames — and returns the unsubscribe. A stream
 * cancelled before the root resolves arms isCancelled, so the late resolve
 * attaches nothing. Instrumented filesystem operations report here; nothing
 * watches the OS.
 */
export const createChangeFeed = (ctx) => {
  const fs = demandFs(ctx);
  const followers = new Set();
  ctx.on('fs/observed', (target, observation) => {
    for (const follower of followers) follower.push(target, observation);
  });
  const frameOf = (rootTarget, target, observation) => {
    if (!fs.contains(rootTarget, target)) return undefined;
    const change = observation?.kind === 'present'
      ? { absolutePath: fs.processPath(target), version: observation.version }
      : { absolutePath: fs.processPath(target), absent: true };
    return { kind: 'change', change };
  };
  return {
    follow: async (root, emit, isCancelled) => {
      const queue = [];
      const buffering = { push: (t, o) => queue.push([t, o]) };
      followers.add(buffering);
      const rootTarget = await fs.resolve(root);
      followers.delete(buffering);
      if (isCancelled?.() === true) return () => {};
      emit({ kind: 'ready' });
      for (const [target, observation] of queue) {
        const frame = frameOf(rootTarget, target, observation);
        if (frame !== undefined) emit(frame);
      }
      const live = {
        push: (target, observation) => {
          const frame = frameOf(rootTarget, target, observation);
          if (frame !== undefined) emit(frame);
        },
      };
      followers.add(live);
      return () => followers.delete(live);
    },
  };
};
