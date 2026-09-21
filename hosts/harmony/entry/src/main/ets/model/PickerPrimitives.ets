// dsh:logging-exempt (hilog here is drive/progress evidence only; canonical
// E2E lines route through the HostPhase phase sink — ONE writer)
/**
 * PickerPrimitives + the user-scope registry — presentPicker
 * (contract/primitives.md §4) over @ohos.file.picker's DocumentViewPicker,
 * plus the fs half of a granted scope: fsScope.persist/resolve and
 * fsRead/fsWrite for `user:` scopes. Platform sibling of hosts/android
 * .../UiPrimitives.kt (SAF) + FsPrimitives.kt's tree handling.
 *
 * A successful pick grants a fresh opaque scope handle `user:<uuid>` bound
 * to the picked URI (user scope — the app holds only what the user chose;
 * fsScope persists the URI in `<filesDir>/scope-registry.json`, refs
 * `bkm:<uuid>`, the HarmonyOS analogue of Android's persistable URI
 * permission). User dismissal resolves null and grants nothing — a value,
 * never an error. Paths inside a granted scope are POSIX-relative; escape
 * attempts are `invalid`, ungranted scopes are `denied`.
 *
 * Every automatable surface emits ui-wait/ui-done hilog markers for the E2E
 * driver, same as presentApproval. Threading: the picker promise completes
 * on the ArkTS main thread event loop — the ONE serial JS runtime thread
 * (ARCHITECTURE.md §6).
 */
import { picker } from '@kit.CoreFileKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'dsh.app';
const USER_PREFIX: string = 'user:';
const BOOKMARK_PREFIX: string = 'bkm:';
const MAX_READ_BYTES: number = 8 * 1024 * 1024;
/** E2E seed: the file the save-dialog bootstrap stages into the user store
 * (the emulator image ships none), and the scenario reads back through the
 * select-granted scope. The name is unique per run — the save dialog REFUSES
 * duplicate names (no replace prompt) — and reaches the scenario through the
 * host.seed bridge event. */
export const SEED_PREFIX: string = 'dsh-e2e-seed-';
export const SEED_CONTENT: string = 'dsh-e2e-seed';

/** (callId, payloadJson, ok) — HostPhase.settleCall's shape. */
export type SettleFn = (callId: number, payloadJson: string, ok: boolean) => void;

interface PickerArgs {
  mode?: string;
  suggestedName?: string;
}

interface ScopeArgs {
  scope?: string;
  path?: string;
  ref?: string;
  bytesB64?: string;
  append?: boolean;
  create?: boolean;
}

interface RegistryEntry {
  uri: string;
  kind: string;
}

function reject(callId: number, settle: SettleFn, code: string, primitive: string,
  message: string): void {
  settle(callId,
    '{"code":"' + code + '","primitive":"' + primitive + '","message":"' +
    message + '"}', false);
}

/** POSIX-relative, no empty/dot/dot-dot components (contract §3). */
function safeRelative(path: string): string | null {
  if (path.length === 0 || path.startsWith('/')) {
    return null;
  }
  const comps = path.split('/').filter((c: string): boolean => c.length > 0);
  if (comps.length === 0) {
    return null;
  }
  for (let i = 0; i < comps.length; i++) {
    if (comps[i] === '..' || comps[i] === '.') {
      return null;
    }
  }
  return comps.join('/');
}

export class PickerPrimitives {
  private ctx: common.UIAbilityContext;
  private registryFile: string;
  private scopes: Map<string, RegistryEntry> = new Map();

  constructor(ctx: common.UIAbilityContext) {
    this.ctx = ctx;
    this.registryFile = ctx.filesDir + '/scope-registry.json';
  }

  // ---- E2E bootstrap seed (not a contract primitive) ------------------------

  /** Stage a known file into the user store through the platform SAVE
   * dialog. The emulator image ships an empty user store (no gallery, no
   * documents) and its image is undebuggable (no shell seeding), so the
   * binding phase bootstraps the file the select-based picker leg will
   * grant on. The save dialog is driven by the E2E driver over the
   * ui-wait/ui-done `picker-seed` markers; the returned URI carries write
   * permission, which fileIo uses to plant the known bytes. Resolves the
   * staged file name ('' when the seed did not happen). */
  seedUserFile(): Promise<string> {
    hilog.info(0x0000, TAG, 'ui-wait picker-seed');
    const seedName = SEED_PREFIX + util.generateRandomUUID(true) + '.txt';
    const saver = new picker.DocumentViewPicker(this.ctx);
    const options: picker.DocumentSaveOptions = {
      newFileNames: [seedName],
    };
    const writeSeed = (uri: string): void => {
      const encoder = util.TextEncoder.create('utf-8');
      const bytes = encoder.encodeInto(SEED_CONTENT);
      const file = fs.openSync(uri,
        fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, bytes.buffer as object as ArrayBuffer);
      } finally {
        fs.closeSync(file.fd);
      }
    };
    return saver.save(options).then((uris: Array<string>): string => {
      if (uris.length === 0) {
        hilog.warn(0x0000, TAG, 'ui-done picker-seed dismissed');
        return '';
      }
      writeSeed(uris[0]);
      hilog.info(0x0000, TAG, 'ui-done picker-seed saved %{public}s', seedName);
      return seedName;
    }).catch((err: BusinessError): string => {
      hilog.error(0x0000, TAG, 'ui-done picker-seed failed: %{public}s',
        err.message ?? 'unknown');
      return '';
    });
  }

  // ---- presentPicker -------------------------------------------------------

  /** presentPicker {mode}: DocumentViewPicker select (FOLDER or FILE). */
  present(callId: number, argsText: string, settle: SettleFn): void {
    let args: PickerArgs = {};
    try {
      args = JSON.parse(argsText) as PickerArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'presentPicker', 'malformed args');
      return;
    }
    const directory = args.mode === 'directory';
    if (args.mode !== undefined && !directory && args.mode !== 'file') {
      reject(callId, settle, 'invalid', 'presentPicker', 'mode must be file|directory');
      return;
    }
    hilog.info(0x0000, TAG, 'ui-wait picker %{public}s', directory ? 'directory' : 'file');
    const documentPicker = new picker.DocumentViewPicker(this.ctx);
    const options: picker.DocumentSelectOptions = {
      maxSelectNumber: 1,
      selectMode: directory ? picker.DocumentSelectMode.FOLDER
        : picker.DocumentSelectMode.FILE,
    };
    documentPicker.select(options).then((uris: Array<string>): void => {
      hilog.info(0x0000, TAG, 'ui-done picker result %{public}d', uris.length);
      if (uris.length === 0) {
        settle(callId, 'null', true); // user dismissal is a value
        return;
      }
      const uri = uris[0];
      const kind = directory ? 'directory' : 'file';
      const handle = this.grant(uri, kind);
      const name = decodeURIComponent(uri.substring(uri.lastIndexOf('/') + 1));
      settle(callId, '{"scope":"' + handle + '","path":"' + name + '"}', true);
    }).catch((err: BusinessError): void => {
      hilog.error(0x0000, TAG, 'ui-done picker failed: %{public}s',
        err.message ?? 'unknown');
      reject(callId, settle, 'unavailable', 'presentPicker',
        err.message ?? 'picker failed');
    });
  }

  // ---- scope registry (grant / persist / resolve) ---------------------------

  /** Binds a fresh user scope handle to a picked URI (in-memory grant). */
  private grant(uri: string, kind: string): string {
    const handle = USER_PREFIX + util.generateRandomUUID(true);
    this.scopes.set(handle, { uri: uri, kind: kind });
    return handle;
  }

  /** fsScope.persist {scope}: app stays C-served; user scopes persist here. */
  persist(callId: number, argsText: string, settle: SettleFn): void {
    let args: ScopeArgs = {};
    try {
      args = JSON.parse(argsText) as ScopeArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'fsScope.persist', 'malformed args');
      return;
    }
    const entry = args.scope === undefined ? undefined : this.scopes.get(args.scope);
    if (entry === undefined) {
      reject(callId, settle, 'denied', 'fsScope.persist',
        'scope not granted: ' + (args.scope ?? ''));
      return;
    }
    const ref = BOOKMARK_PREFIX + util.generateRandomUUID(true);
    const registry: Record<string, RegistryEntry> = this.readRegistry();
    registry[ref] = entry;
    this.writeRegistry(registry);
    settle(callId, '{"ref":"' + ref + '"}', true);
  }

  /** fsScope.resolve {ref}: restores a persisted ref into a fresh handle. */
  resolve(callId: number, argsText: string, settle: SettleFn): void {
    let args: ScopeArgs = {};
    try {
      args = JSON.parse(argsText) as ScopeArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'fsScope.resolve', 'malformed args');
      return;
    }
    if (args.ref === undefined || !args.ref.startsWith(BOOKMARK_PREFIX)) {
      reject(callId, settle, 'invalid', 'fsScope.resolve', 'malformed ref');
      return;
    }
    const registry: Record<string, RegistryEntry> = this.readRegistry();
    const entry = registry[args.ref];
    if (entry === undefined) {
      reject(callId, settle, 'io', 'fsScope.resolve', 'ref no longer resolves');
      return;
    }
    const handle = this.grant(entry.uri, entry.kind);
    settle(callId, '{"scope":"' + handle + '"}', true);
  }

  // ---- user-scope fs (fsRead / fsWrite on granted scopes) -------------------

  read(callId: number, argsText: string, settle: SettleFn): void {
    let args: ScopeArgs = {};
    try {
      args = JSON.parse(argsText) as ScopeArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'fsRead', 'malformed args');
      return;
    }
    const rel = args.path === undefined ? null : safeRelative(args.path);
    const entry = args.scope === undefined ? undefined : this.scopes.get(args.scope);
    if (rel === null || entry === undefined) {
      reject(callId, settle, entry === undefined ? 'denied' : 'invalid', 'fsRead',
        entry === undefined ? 'scope not granted' : 'path escapes its scope');
      return;
    }
    const target = this.targetUri(entry, rel);
    try {
      const file = fs.openSync(target, fs.OpenMode.READ_ONLY);
      try {
        const size = fs.statSync(file.fd).size;
        if (size > MAX_READ_BYTES) {
          reject(callId, settle, 'invalid', 'fsRead', 'file too large');
          return;
        }
        const buf = new ArrayBuffer(size);
        fs.readSync(file.fd, buf);
        const b64 = new util.Base64Helper()
          .encodeToStringSync(new Uint8Array(buf));
        const mtime = new Date(fs.statSync(file.fd).mtime * 1000).toISOString();
        settle(callId, '{"bytesB64":"' + b64 + '","mtime":"' + mtime + '"}', true);
      } finally {
        fs.closeSync(file.fd);
      }
    } catch (e) {
      const message = (e as BusinessError).message ?? 'read failed';
      reject(callId, settle, 'io', 'fsRead', message);
    }
  }

  write(callId: number, argsText: string, settle: SettleFn): void {
    let args: ScopeArgs = {};
    try {
      args = JSON.parse(argsText) as ScopeArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'fsWrite', 'malformed args');
      return;
    }
    const rel = args.path === undefined ? null : safeRelative(args.path);
    const entry = args.scope === undefined ? undefined : this.scopes.get(args.scope);
    if (rel === null || entry === undefined) {
      reject(callId, settle, entry === undefined ? 'denied' : 'invalid', 'fsWrite',
        entry === undefined ? 'scope not granted' : 'path escapes its scope');
      return;
    }
    const bytes = new util.Base64Helper().decodeSync(args.bytesB64 ?? '');
    const target = this.targetUri(entry, rel);
    try {
      const create = args.create === undefined ? true : args.create;
      if (!create && !fs.accessSync(target)) {
        reject(callId, settle, 'io', 'fsWrite', rel + ' does not exist');
        return;
      }
      const mode = args.append === true
        ? fs.OpenMode.READ_WRITE | fs.OpenMode.APPEND | fs.OpenMode.CREATE
        : fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC;
      const file = fs.openSync(target, mode);
      try {
        fs.writeSync(file.fd, bytes.buffer as object as ArrayBuffer);
      } finally {
        fs.closeSync(file.fd);
      }
      settle(callId, '{"written":' + bytes.length + '}', true);
    } catch (e) {
      const message = (e as BusinessError).message ?? 'write failed';
      reject(callId, settle, 'io', 'fsWrite', message);
    }
  }

  /** A file grant reads/writes the file itself; a directory grant joins the
   * relative path (picker URIs are path-based file:// URIs). */
  private targetUri(entry: RegistryEntry, rel: string): string {
    if (entry.kind === 'file') {
      return entry.uri;
    }
    return entry.uri.endsWith('/') ? entry.uri + rel : entry.uri + '/' + rel;
  }

  private readRegistry(): Record<string, RegistryEntry> {
    try {
      return JSON.parse(fs.readTextSync(this.registryFile)) as
        Record<string, RegistryEntry>;
    } catch (e) {
      return {};
    }
  }

  private writeRegistry(registry: Record<string, RegistryEntry>): void {
    const file = fs.openSync(this.registryFile,
      fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, JSON.stringify(registry));
    } finally {
      fs.closeSync(file.fd);
    }
  }
}
