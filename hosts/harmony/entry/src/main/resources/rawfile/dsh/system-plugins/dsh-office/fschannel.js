// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * The fs channel: how office tools touch workspace files.
 *
 * dsh-office-tools spoke the desktop `ctx.fs` service (resolve/stat/
 * readBytes/writeText + a sandbox policy); this runtime's equivalent is the
 * contract's fs primitives over the pinned profile workspace — the same
 * scopePathFor mapping dsh-shell-wasm uses (both roots are globals the
 * spine sets; the mapping is read, never guessed). Semantics kept from the
 * port: extension allowlist, the 50 MB file cap, the create-overwrite guard,
 * and lexical escape refusal (the gateway refuses escapes too; naming the
 * path here gives the model a clean error instead of a gateway code).
 */
import { createLogger } from 'logger.js';
import { fsRead, fsStat, fsWrite, GatewayError } from 'gateway.js';
import { MAX_OFFICE_FILE_BYTES } from './shared.js';

const log = createLogger('dsh.office.fs');

/** The workspace-relative path mapped onto the gateway's (scope, path)
 * pair — verbatim from dsh-shell-wasm's scopePathFor. */
export const scopePathFor = (relative) => {
  const workspace = globalThis.__dshProfileCwd;
  const scopeRoot = globalThis.__dshProfileScopeRoot;
  if (typeof workspace !== 'string' || typeof scopeRoot !== 'string'
      || !workspace.startsWith(scopeRoot)) {
    throw new GatewayError('unavailable', 'office',
      'the host granted no scoped workspace (no __dshProfileScopeRoot)');
  }
  const prefix = workspace.slice(scopeRoot.length).replace(/^\/+/, '');
  const clean = String(relative).replace(/^\/+/, '');
  return { scope: 'app', path: prefix.length > 0 ? `${prefix}/${clean}` : clean };
};

const extensionOf = (path) => {
  const at = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return at > slash ? path.slice(at).toLowerCase() : '';
};

/** Lexical escape check over the workspace-relative spelling — "../" must
 * never survive into a displayed path, even where the gateway would refuse
 * it anyway (rule 5: the refusal names the path). */
const assertLexicallyInside = (rawPath) => {
  const segments = String(rawPath).replace(/\/+$/, '').split('/');
  let depth = 0;
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) {
        throw new Error(`path "${rawPath}" escapes the session workspace`);
      }
      continue;
    }
    depth += 1;
  }
};

/** Resolve one user-supplied office path: confined, extension-checked,
 * optionally proven to be an existing regular file. Returns the gateway
 * target plus the display spelling and the lowercase extension. */
export const resolveOfficePath = async (rawPath, allowedExts, mustExist) => {
  log.debug('resolve office path', { rawPath, mustExist });
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('path must be a non-empty string');
  }
  assertLexicallyInside(rawPath);
  const target = scopePathFor(rawPath);
  const ext = extensionOf(target.path);
  if (!allowedExts.includes(ext)) {
    throw new Error(`expected ${allowedExts.join(' or ')} file, got extension "${ext || '(none)'}"`);
  }
  if (mustExist) {
    const info = await fsStat(target.scope, target.path);
    if (info.kind !== 'file') {
      throw new Error(`"${rawPath}" does not exist in the workspace (or is not a regular file)`);
    }
  }
  return { ...target, ext };
};

/** Read one office file's bytes, through the whole-file size cap. */
export const readOfficeBytes = async (target) => {
  const info = await fsStat(target.scope, target.path);
  const declared = info.size ?? 0;
  if (declared > MAX_OFFICE_FILE_BYTES) {
    throw new Error(`the file is ${declared} bytes; office tools refuse files larger than ${MAX_OFFICE_FILE_BYTES} bytes`);
  }
  const { bytes } = await fsRead(target.scope, target.path);
  log.debug('office bytes read', { path: target.path, sizeBytes: bytes.byteLength });
  return { bytes, sizeBytes: bytes.byteLength };
};

/** Publish one office file's bytes (create: true — resolveOfficePath and
 * assertMayCreate own the exists-decision before this runs). */
export const saveOfficeBytes = async (target, bytes) => {
  const { written } = await fsWrite(target.scope, target.path, bytes, { create: true });
  log.debug('office bytes written', { path: target.path, sizeBytes: written });
  return written;
};

/** The create-overwrite guard: an existing file refuses word_create/excel_create/ppt_create
 * unless the call passed overwrite: true (the port of assertMayCreate). */
export const assertMayCreate = async (target, overwrite) => {
  if (overwrite) return;
  const info = await fsStat(target.scope, target.path);
  if (info.kind === 'file') {
    throw new Error('the target already exists; pass overwrite: true to replace it');
  }
};
