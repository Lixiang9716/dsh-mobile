// dsh:logging-exempt (shim layer)
/**
 * node:fs shim — LOUD stubs: the spike runtime has no synchronous filesystem
 * (the gateway fs primitives are async and scope-confined per contract/).
 *
 * Covers (upstream usage → this module):
 *   - dsh-sandbox (`accessSync`, `constants`, `realpathSync`, `statSync`) —
 *     the local-sandbox path validator. That validator is the DESKTOP
 *     sandbox's disk gate; on mobile the same boundary is the gateway fs
 *     scope (see runtime/spike/upstream/README.md, mapping table). The names
 *     exist so the vendored module links; any CALL fails loud naming the
 *     seam that must be wired (PR-B: subprocess/fs service over the gateway).
 *
 * Intentionally NOT supported: every synchronous read/write (fail loud), the
 * promise APIs object (link error on import), streams (link error).
 */
export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  S_IFDIR: 0x4000,
  S_IFREG: 0x8000,
};

const refuse = (name) => () => {
  throw new Error(
    `node:fs.${name}: no synchronous filesystem in the spike runtime — `
    + 'this path is a desktop host capability; on mobile the same boundary is the '
    + 'gateway fs scope (see runtime/spike/upstream/README.md)');
};

export const accessSync = refuse('accessSync');
export const realpathSync = Object.assign(refuse('realpathSync'), {
  native: refuse('realpathSync.native'),
});
export const statSync = Object.assign(refuse('statSync'), {
  statSync: undefined,
});
export const lstatSync = refuse('lstatSync');
export const readFileSync = refuse('readFileSync');
export const writeFileSync = refuse('writeFileSync');
export const existsSync = refuse('existsSync');
export const mkdirSync = refuse('mkdirSync');
export const rmSync = refuse('rmSync');
export const readdirSync = refuse('readdirSync');
export default { constants, accessSync, realpathSync, statSync, lstatSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync };
