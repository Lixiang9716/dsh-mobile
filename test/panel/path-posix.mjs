import { createRequire } from 'node:module';

// The path algebra for the fs-shim suites: the shim family models a POSIX
// device (mountWorkspace demands '/'-prefixed roots and the seam passes the
// device spellings back), but `node:path` resolves to path.win32 on a
// Windows host, so the first join inside a shim backslash-contaminates the
// device spelling and the containment gate refuses it. Aliased over
// 'node:path' in the panel config and the toolface loader hooks, this module
// pins the shim world to the posix namespace on every host. Host-side code
// keeps working: node's fs accepts forward-slash Windows paths, and the
// fixture tree is spelled '/tmp/...' end to end (see posix-fixture.mjs).
//
// The real builtin comes in through createRequire: a plain `node:path`
// import would hit this module's own alias and recurse. (The loader hooks
// also exempt this file by parent URL — belt and braces.)
const { posix } = createRequire(import.meta.url)('node:path');

export const {
  basename,
  delimiter,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} = posix;
export default posix;
