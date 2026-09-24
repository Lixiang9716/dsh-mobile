// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-picker.js — the directoryPicker COVERAGE adapters
 * (decision D9, api-full-coverage work stream): the in-app directory browser
 * the official workspace flows read (`list`, `createDirectory`), answered
 * over the REAL vendored `fs` service within the pinned workspace world.
 * Shapes mirror the upstream browse backend at the pin
 * (dsh-host-directory-picker-browse + packages/api/workspace-controller/
 * directory-picker.ts): directory rows only, name-sorted, hidden flagged,
 * whole-level entry cap 1000, the directory-picker/* failure vocabulary.
 * `pick` is NOT covered: the native OS chooser is a desktop host capability
 * (the seam's own `directory-picker/unavailable` refusal names it), so the
 * endpoint stays unclaimed.
 */
import { remoteError } from 'upstream/web-write.js';
import { lexical, wsMkdir } from 'upstream/shims/fs-workspace.js';

/** The browse backend's default whole-level bound (GitHub's web UI rule). */
const PICKER_MAX_ENTRIES = 1000;

/** The world root's listing path and the crumb name for it (a root crumb
 * carries its full path — the upstream DirectoryEntry contract). */
const rootCrumb = (root) => ({ name: root, path: root, hidden: false });

/** The ancestor chain from the world root to `absolute`, inclusive. */
const crumbsOf = (root, absolute) => {
  if (absolute === root) return [rootCrumb(root)];
  const crumbs = [rootCrumb(root)];
  const rest = absolute.slice(root.length + 1).split('/');
  let current = root;
  for (const segment of rest) {
    current = `${current}/${segment}`;
    crumbs.push({ name: segment, path: current, hidden: false });
  }
  return crumbs;
};

/** The fs service with the picker's demand (loud when unmounted). */
const pickerFs = (ctx) => {
  const fs = ctx.get('fs');
  if (fs === undefined) {
    throw remoteError('gateway/unavailable', 'no fs service is mounted', {});
  }
  return fs;
};

/** Resolve one absolute world path to a directory target, mapping the
 * browse-backend refusals onto the picker vocabulary. */
const demandDirectory = async (fs, root, absolute) => {
  const entry = await fs.lstat(absolute, { cwd: root }).catch((error) => {
    throw remoteError('directory-picker/unreadable',
      `cannot list "${absolute}": ${error?.message ?? String(error)}`,
      { path: absolute });
  });
  if (entry === undefined || entry.type !== 'directory') {
    throw remoteError('directory-picker/unreadable',
      `"${absolute}" is not a directory`, { path: absolute });
  }
  return fs.resolve(absolute);
};

/** One directory level plus its ancestry, child directories only. */
export const makeDirectoryPickerList = (ctx, deps) => async (args) => {
  const fs = pickerFs(ctx);
  const requested = args?.path;
  const root = deps.root;
  if (requested !== undefined && typeof requested !== 'string') {
    throw remoteError('gateway/bad-request', 'path must be a string', {});
  }
  const absolute = requested === undefined || requested === ''
    ? root : lexical(requested);
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw remoteError('directory-picker/unreadable',
      `"${requested}" is outside the served directory root`, { path: requested });
  }
  const target = await demandDirectory(fs, root, absolute);
  const children = (await fs.listDir(target))
    .filter((child) => child.type === 'directory')
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return {
    path: absolute,
    home: root,
    crumbs: crumbsOf(root, absolute),
    entries: children.slice(0, PICKER_MAX_ENTRIES).map((child) => ({
      name: child.name,
      path: `${absolute}/${child.name}`,
      hidden: child.name.startsWith('.'),
    })),
    truncated: children.length > PICKER_MAX_ENTRIES,
  };
};

/** Create one child directory under an existing world directory. Returns
 * the created directory's absolute path (the upstream wire result). */
export const makeDirectoryPickerCreate = (ctx, deps) => async (args) => {
  const fs = pickerFs(ctx);
  const path = args?.path;
  const name = args?.name;
  if (typeof name !== 'string' || name.trim() === '' || name === '.'
    || name === '..' || /[/\\]/.test(name)) {
    throw remoteError('gateway/bad-request',
      'directoryPicker.createDirectory requires a single non-blank path segment name', {});
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw remoteError('gateway/bad-request', 'path is required', {});
  }
  const absolute = lexical(path);
  const root = deps.root;
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw remoteError('directory-picker/unreadable',
      `"${path}" is outside the served directory root`, { path });
  }
  await demandDirectory(fs, root, absolute);
  const created = `${absolute}/${name}`;
  try {
    wsMkdir(created);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw remoteError('directory-picker/exists',
        `"${created}" already exists`, { path: created });
    }
    throw remoteError('directory-picker/create-failed',
      `cannot create "${created}": ${error?.message ?? String(error)}`,
      { path: created });
  }
  return created;
};
