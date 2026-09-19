/**
 * dsh-fs — system implementation plugin for the `fs` service (M2 v0).
 *
 * Platform-neutral: consumes ONLY the frozen contract primitives
 * (fsRead / fsWrite / fsScope via the runtime/spike gateway shim) and the
 * unified logger. Everything is scope-relative POSIX: paths must be
 * relative, dot-free of `..` segments, and stay inside the granted scope —
 * violations reject with the contract's "invalid" code before any primitive
 * call leaves the plugin (defense in depth; the host re-checks).
 */
import { createLogger } from 'logger.js';
import { fsRead, fsWrite, GatewayError } from 'gateway.js';

const log = createLogger('dsh.fs');

/** The static manifest this plugin installs under (schemaVersion 1). */
export const manifest = {
  schemaVersion: 1,
  id: 'dsh-fs',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['fsRead', 'fsWrite', 'fsScope'], optional: [] },
  hooks: { activate: 'activate' },
};

/** Scope-relative POSIX path guard: relative, no `..`, no empty segments. */
const assertPath = (path) => {
  log.debug('path check', { path });
  const bad = typeof path !== 'string' || path.length === 0 || path.startsWith('/')
    || path.split('/').some((seg) => seg === '' || seg === '.')
    || path.split('/').includes('..');
  if (bad) throw new GatewayError('invalid', 'fs', `path escapes its scope: ${path}`);
};

const encode = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
const decode = (bytes) => [...bytes].map((c) => String.fromCharCode(c)).join('');

/** Byte io over the primitives. */
const makeIo = () => {
  const read = async (scope, path) => {
    log.debug('fs.read', { scope, path });
    assertPath(path);
    return await fsRead(scope, path);
  };
  const write = async (scope, path, bytes, opts = {}) => {
    log.debug('fs.write', { scope, path, bytes: bytes.length, append: !!opts.append });
    assertPath(path);
    return await fsWrite(scope, path, bytes, opts);
  };
  return { read, write };
};

/** Text flavors over the byte io (UTF-8 callers use ASCII in v0). */
const makeText = (io) => {
  const readText = async (scope, path) => {
    const { bytes, mtime } = await io.read(scope, path);
    log.debug('fs.readText', { scope, path, chars: bytes.length });
    return { text: decode(bytes), mtime };
  };
  const writeText = async (scope, path, text, opts = {}) => {
    log.debug('fs.writeText', { scope, path, chars: text.length });
    return await io.write(scope, path, encode(text), opts);
  };
  const appendText = async (scope, path, text) => {
    log.debug('fs.appendText', { scope, path, chars: text.length });
    return await writeText(scope, path, text, { append: true });
  };
  return { readText, writeText, appendText };
};

/** Introspection over the byte io. exists is false ONLY on the io miss —
 * every other GatewayError (denied/invalid/...) propagates to the caller. */
const makeMeta = (io) => {
  const exists = async (scope, path) => {
    log.debug('fs.exists', { scope, path });
    try {
      await io.read(scope, path);
      return true;
    } catch (err) {
      if (err && err.code === 'io') return false;
      throw err;
    }
  };
  const stat = async (scope, path) => {
    const { bytes, mtime } = await io.read(scope, path);
    log.debug('fs.stat', { scope, path, size: bytes.length });
    return { size: bytes.length, mtime };
  };
  return { exists, stat };
};

/** Activation hook (manifest.hooks.activate): registers the `fs` service. */
export function activate({ register }) {
  log.debug('activating dsh-fs');
  const io = makeIo();
  register('fs', { ...io, ...makeText(io), ...makeMeta(io) });
}
