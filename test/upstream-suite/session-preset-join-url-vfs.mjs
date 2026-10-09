// dsh:logging-exempt (test adapter: no logging surface of its own)
/**
 * session-preset-join-url-vfs.mjs — the node:url adapter the session-preset-
 * join hooks serve to VENDORED code. The boot pins ctx.baseUrl to
 * 'file:///vendor/dsh/agent-presets@<ver>/' — the staged-VFS spelling the
 * quickjs host serves and the preset health walk resolves row packages
 * against. On a real filesystem those are not absolute Windows paths, so
 * this adapter translates the /vendor/... prefix to the vendored closure
 * (runtime/dsh/vendor/...) in both directions. Every other node:url face
 * passes through.
 */
import { pathToFileURL as realToFile, fileURLToPath as realToPath } from 'node:url';
import { resolve as pathResolve, dirname } from 'node:path';

const HERE = dirname(realToPath(import.meta.url));
const VENDOR = pathResolve(HERE, '../../runtime/dsh/vendor');
const VENDOR_POSIX = VENDOR.split('\\').join('/');

const toReal = (p) => {
  const norm = String(p).split('\\').join('/');
  if (norm.startsWith('/vendor/')) return `${VENDOR_POSIX}${norm.slice('/vendor'.length)}`;
  return p;
};

export const fileURLToPath = (url) => {
  try {
    return realToPath(url);
  } catch (e) {
    if (typeof url === 'string' && url.startsWith('file:///vendor/')) {
      return toReal(url.slice('file://'.length));
    }
    throw e;
  }
};

export const pathToFileURL = (path) => {
  try {
    return realToFile(path);
  } catch (e) {
    const mapped = toReal(path);
    if (mapped !== path) return realToFile(mapped);
    throw e;
  }
};
