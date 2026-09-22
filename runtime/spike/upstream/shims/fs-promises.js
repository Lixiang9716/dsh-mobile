// dsh:logging-exempt (shim; the fs/promises face of the spike's staged fs)
/**
 * node:fs/promises — the ASYNC face of the staged in-memory file view.
 *
 * Why this exists: the vendored agent-presets service walks its presets tree
 * with async readFile/readdir/stat. The sync fs shim's VFS already holds
 * seeded staged files (web-plugins, and — since the VFS roots were widened —
 * the /vendor tree a driver seeds); this module is the same view behind
 * promises, plus HONEST refusals for the write-side calls the package
 * imports (chmod/cp/rm): a preset tree is seed data, read-only by
 * construction, and pretending to write it would corrupt nothing but trust.
 *
 * The async shape is not decoration: importing the package failed outright
 * until this module existed (`no spike shim for node:fs/promises`), because
 * an ESM named import from a missing module is a link error, not a lazy one.
 */
import {
  existsSync,
  readFileSync,
  statSync,
  readdirSync,
} from 'node:fs';

const refuseAsync = (name) => async () => {
  throw new Error(
    `node:fs/promises.${name}: the staged fs view is read-only — `
    + 'seed data cannot be mutated inside the spike runtime');
};

/** readFile(path[, options]) — utf8 string or Buffer, like node. */
export const readFile = async (path, options) => {
  if (!existsSync(path)) {
    const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
    error.code = 'ENOENT';
    throw error;
  }
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return readFileSync(path, encoding ?? 'buffer');
};

/** readdir(path[, {withFileTypes}]) — one level, sorted. withFileTypes asks
 * for Dirent-shaped entries ({name, isDirectory(), isFile()}) — what the
 * presets walk iterates; the shapes come from per-entry stat over the VFS. */
export const readdir = async (path, options) => {
  const names = readdirSync(path);
  if (options?.withFileTypes !== true) return names;
  return Promise.all(names.map(async (name) => {
    const full = `${path.endsWith('/') ? path : `${path}/`}${name}`;
    let entry;
    try {
      entry = await stat(full);
    } catch {
      entry = { isFile: () => true, isDirectory: () => false };
    }
    return { name, isDirectory: entry.isDirectory, isFile: entry.isFile };
  }));
};

/** stat(path) — the sync shim's answer (isFile/isDirectory/size/mtimeMs). */
export const stat = async (path) => statSync(path);

// The write-side names below are EXPORTED because the vendored closure's
// imports link against them (a missing ESM export is a link error, not a lazy
// one) — and they REFUSE at call time: seed data is read-only, and the honest
// error names the boundary instead of corrupting the staged view.
export const chmod = refuseAsync('chmod');
export const cp = refuseAsync('cp');
export const rm = refuseAsync('rm');
export const writeFile = refuseAsync('writeFile');
export const appendFile = refuseAsync('appendFile');
export const rename = refuseAsync('rename');
export const mkdir = refuseAsync('mkdir');
export const unlink = refuseAsync('unlink');

/** access() succeeds for existence checks on readable staged paths — the one
 * write-side name whose SEMANTICS are read-shaped. Mode bits are ignored: the
 * VFS has no permission model (contract/primitives.md §3 — paths are paths). */
export const access = async (path) => {
  if (!existsSync(path) && readdirSync(path) === null) {
    const error = new Error(`ENOENT: no such file or directory, access '${path}'`);
    error.code = 'ENOENT';
    throw error;
  }
};

/** constants: the O_* flags access/write paths pass; the VFS has no real
 * permission model, so the values are node's and semantics are existence. */
export const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
};

/** realpath(): the VFS keys ARE canonical (seeded absolute paths), so this is
 * identity for known paths and ENOENT otherwise — matching the sync shim's
 * shape without pretending to resolve links. */
export const realpath = async (path) => {
  if (!existsSync(path) && readdirSync(path) === null) {
    const error = new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    error.code = 'ENOENT';
    throw error;
  }
  return path;
};

/** opendir(): the async iterator face of readdir, one level. The presets
 * walk uses it (home-paths' user-root scan); each entry carries name plus
 * node's isDirectory/isFile projections. */
export const opendir = async (path) => {
  const names = readdirSync(path);
  let index = 0;
  return {
    async read() {
      if (index >= names.length) return null;
      const name = names[index++];
      const full = `${path.endsWith('/') ? path : `${path}/`}${name}`;
      let entry;
      try {
        entry = await stat(full);
      } catch {
        entry = { isFile: () => true, isDirectory: () => false };
      }
      return { name, isDirectory: entry.isDirectory, isFile: entry.isFile };
    },
    async close() { /* nothing held */ },
    [Symbol.asyncIterator]() { return this; },
  };
};

export default {
  readFile, readdir, stat, chmod, cp, rm,
  writeFile, appendFile, rename, mkdir, unlink, access,
  constants, realpath, opendir,
};
