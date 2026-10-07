/**
 * upstream/web-write-plugin-manager.js — the pluginManager WRITE legs
 * (issue #335 A1) over the REAL §4 install pipeline + the receipts journal
 * + the workspace dsh.plugins/1 registry.
 *
 * v1 SCOPE — the workspace scope is the security boundary. This host runs
 * no package manager and spawns no host processes (the mobile D-rules), so
 * the desktop's pnpm install/remove path has no honest analog. What DOES
 * exist — proven by the marketplace face (web-write-marketplace.js) — is
 * the §4 transaction (installFromFetch → receipt journal) and the registry
 * document the one-sentence-creation path writes. Every leg operates on
 * exactly those two state planes:
 *
 *   installBundle(spec)  → a BARE registry name only, resolved from the
 *                  staged marketplace index and installed through the REAL
 *                  installFromFetch with the verified index's trust record;
 *                  then adopted into the registry (enabled unless
 *                  options.enabled === false). A path/git/tarball spec —
 *                  or an install with no staged index — refuses in-band.
 *   removeBundle(name)   → fsRemove of the committed tree + the §4 remove
 *                  receipt (the receipt lands after the tree is gone) +
 *                  the registry row dropped (agent-authored workspace
 *                  FILES are not deleted — only the roster row goes).
 *   setBundleEnabled / setPluginEnabled → the registry row's enabled flag
 *                  flips (read-modify-write). The registry IS the
 *                  persistent patch target — the list legs carry
 *                  patchId plugins/registry.json on these rows.
 *   inspect(spec)   → reads what the spec names: the installed tree's REAL
 *                  manifest.json (re-validated), else the staged index
 *                  entry, else the refused vocabulary.
 *   cancelInstall   → answers `not-running`: v1 runs no cancellable
 *                  background install (each install completes inside its
 *                  own handler call), so every requestId names nothing.
 *
 * REFUSALS ARE IN-BAND (rule 5 + the #312 lesson): a handler here never
 * throws. The ChangeResult legs answer `application: 'failed'` with the
 * vendor ManagementError vocabulary; inspect answers `status: 'refused'`
 * with its problem vocabulary; cancelInstall's vocabulary has no failure
 * member at all. The ONE throw is syncInspectManifest's malformed-args
 * rejection (web-write-cordis.js) — a null-only result has no in-band
 * failure member, so the gateway RemoteError envelope is that call's
 * designed error channel.
 */
import { createLogger } from 'logger.js';
import { httpFetch, fsRead, fsWrite, fsRemove } from 'gateway.js';
import { installFromFetch } from 'install-fetch.js';
import { validateManifest } from 'install-pipeline.js';
import { readJournal, appendReceipt } from 'receipt-journal.js';
import { fetchIndex, lookupEntry, MarketplaceRejected } from 'marketplace-resolver.js';
import { installedFromJournal } from 'upstream/web-write-marketplace.js';

const log = createLogger('dsh.web.plugin-manager');

/** The dsh.plugins/1 document (scenario/write-surface-options.js reads the
 * same file leniently for the LIST tier; the WRITE plane reads it strict —
 * a write into a roster this host cannot parse must never silently land).
 * DEFAULT spelling: the app-scope-root-relative `plugins/registry.json`.
 * #346: the workspace registry lives at `<containerRoot>/plugins/
 * registry.json`, which on a real device seat is BELOW the app scope's
 * root — the boot relays the derived spelling as `deps.registryPath`
 * (write-surface-options.js), and a handler family built without one keeps
 * this default (the §4 drive seats whose workspace IS the scope root). */
const REGISTRY_PATH = 'plugins/registry.json';
/** The rows' persistent patch target: the workspace registry IS where the
 * enablement of this tier persists (the list legs carry it verbatim). */
export const WORKSPACE_PATCH_ID = REGISTRY_PATH;

/** The effective registry path for one handler family (the injected
 * spelling wins; the default keeps the historical drive seats honest). */
const registryPathOf = (deps) => (typeof deps?.registryPath === 'string'
  && deps.registryPath.length > 0 ? deps.registryPath : REGISTRY_PATH);

/** Package ids this host adopts — the same grammar the receipts and the
 * marketplace catalog use (install-pipeline.js PKG_ID). */
const PKG_ID = /^[a-z0-9][a-z0-9.-]*$/;

/** The UTF-8 face, resolved once: the dsh host's node:buffer shim carries
 * decodeUtf8/encodeUtf8 (quickjs has no TextDecoder); real node runtimes
 * (the panel suite) answer the same face over the platform globals. */
let utf8FaceCache = null;
const utf8Face = async () => {
  if (utf8FaceCache !== null) return utf8FaceCache;
  const dsh = await import('node:buffer').catch(() => undefined);
  const spikeFace = typeof dsh?.decodeUtf8 === 'function'
    && typeof dsh?.encodeUtf8 === 'function';
  log.debug('utf8 face resolved', { dsh: spikeFace });
  utf8FaceCache = spikeFace
    ? { decode: dsh.decodeUtf8, encode: dsh.encodeUtf8 }
    : {
      decode: (bytes) => new TextDecoder().decode(bytes),
      encode: (text) => new TextEncoder().encode(text),
    };
  return utf8FaceCache;
};

/** The gateway GET transport (the marketplace face's own spelling). */
const fetchGet = (url) => httpFetch(url, { method: 'GET' });

/** In-band ChangeResult failure with the vendor ManagementError code. */
const changeFailed = (stage, target, code, diagnostic) => {
  log.debug('leg refused in-band', { stage, target, code });
  return { changed: false, application: 'failed', stage, target,
    error: { code, diagnostic } };
};

/** In-band inspect refusal with the vendor problem vocabulary. */
const inspectRefused = (problem, reason) => {
  log.debug('inspect refused', { problem });
  return { status: 'refused', problem, reason };
};

/** Map one thrown rejection onto the ManagementError vocabulary: a catalog
 * miss is `unknown-plugin`, an unstaged source is `unaddressable`, and
 * everything else (network, signature, pipeline, fs) is `operation-error` —
 * the diagnostic carries the real message either way. */
const failCodeOf = (error) => {
  log.debug('classify rejection', { name: error?.name, code: error?.code ?? null });
  if (!(error instanceof MarketplaceRejected)) return 'operation-error';
  if (error.code === 'missing-entry') return 'unknown-plugin';
  if (error.code === 'no-source') return 'unaddressable';
  return 'operation-error';
};

/** The bare-registry-name validation every spec-keyed leg shares. */
const specProblem = (spec) => {
  log.debug('spec validate', { spec });
  if (typeof spec !== 'string' || spec.trim() === '') {
    return 'a bare registry package name is required';
  }
  if (!PKG_ID.test(spec)) {
    return `v1 workspace scope adopts bare registry names only`
      + ` (path/git/tarball specs need host processes this host refuses): `
      + `${JSON.stringify(spec)}`;
  }
  return null;
};

/** Strict dsh.plugins/1 read: a missing file is the fresh roster; anything
 * unparsable or off-version THROWS — the caller frames it in-band. */
const readRegistryDoc = async (registryPath) => {
  const { decode } = await utf8Face();
  let raw;
  try {
    const { bytes } = await fsRead('app', registryPath);
    raw = decode(bytes);
  } catch (err) {
    log.debug('registry absent — fresh roster', { code: err?.code });
    return { version: 1, plugins: [] };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${registryPath} is not valid JSON: ${err.message}`);
  }
  if (doc?.version !== 1 || !Array.isArray(doc.plugins)) {
    throw new Error(`not a dsh.plugins/1 document: ${registryPath}`);
  }
  log.debug('registry read', { plugins: doc.plugins.length });
  return doc;
};

/** Read-modify-write of the registry document (unknown doc/entry fields are
 * preserved — agent-authored rows carry fields this plane does not own). */
const writeRegistryDoc = async (registryPath, doc) => {
  const { encode } = await utf8Face();
  log.debug('registry write', { plugins: doc.plugins.length });
  await fsWrite('app', registryPath,
    encode(`${JSON.stringify(doc, null, 2)}\n`));
};

/** The registry row for `id`, or undefined. */
const registryRow = (doc, id) =>
  doc.plugins.find((row) => row !== null && typeof row === 'object' && row.id === id);

/**
 * The in-band frame every ChangeResult leg runs under: the leg's refusal —
 * malformed args, unknown names, failed transactions — resolves into the
 * wire's own `application: 'failed'` shape, never a throw (an exception
 * would ride the resident dispatcher's rejection path and kill the whole
 * drive — the #312 lesson). `targetOf` names the leg's target.
 */
const inBand = (stage, targetOf, run) => async (args) => {
  const target = targetOf(args);
  log.debug('leg begin', { stage, target });
  try {
    return await run(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const named = typeof target === 'string' ? target : '';
    const bad = !PKG_ID.test(named);
    return changeFailed(stage, named, bad ? 'invalid-spec' : failCodeOf(error),
      message);
  }
};

/** The verified index (cached per url by the resolver) or a thrown
 * rejection the in-band frame classifies. */
const stagedIndex = (marketplace) => {
  log.debug('index resolve', { staged: marketplace !== undefined });
  if (marketplace === undefined || marketplace === null) {
    throw new MarketplaceRejected('no-source',
      'no package source is staged on this host (marketplace index unconfigured)');
  }
  return fetchIndex({ url: marketplace.indexUrl, fetchImpl: fetchGet,
    pinnedKey: marketplace.publicKey });
};

/** installBundle: resolve → the REAL §4 transaction (journal: true — the
 * receipt journal is the install record of truth) → registry adoption.
 * An id+version already committed skips the transaction and only ensures
 * the registry row (the adopt is idempotent; `changed` says so). */
const installBundle = (deps) => {
  const registryPath = registryPathOf(deps);
  return inBand('install', (a) => a?.spec, async (args) => {
  const spec = args?.spec;
  const problem = specProblem(spec);
  if (problem) return changeFailed('install', String(spec ?? ''), 'invalid-spec', problem);
  const doc = await stagedIndex(deps.marketplace);
  const entry = lookupEntry(doc, spec);
  const committed = (await installedFromJournal(await readJournal()))
    .find((item) => item.id === entry.id && item.version === entry.version);
  if (committed === undefined) {
    await installFromFetch({
      fetchImpl: fetchGet,
      url: entry.tgzUrl,
      id: entry.id,
      trust: { blobSha256: entry.blobSha256, manifestSha256: entry.manifestSha256 },
      txId: `pm-${Date.now()}-${entry.id}`,
      journal: true,
    });
  }
  const enabled = args?.options?.enabled !== false;
  const regDoc = await readRegistryDoc(registryPath);
  const row = registryRow(regDoc, entry.id);
  if (row === undefined) {
    regDoc.plugins.push({ id: entry.id, name: entry.id, enabled,
      version: entry.version });
    await writeRegistryDoc(registryPath, regDoc);
  } else if (row.enabled !== enabled || row.version !== entry.version) {
    Object.assign(row, { enabled, version: entry.version });
    await writeRegistryDoc(registryPath, regDoc);
  }
  log.debug('install applied', { id: entry.id, version: entry.version,
    enabled, transaction: committed === undefined });
  return { changed: committed === undefined, application: 'applied',
    stage: 'install', target: spec, bundle: entry.id, enabled };
});
};

/** removeBundle: the committed tree goes, THEN the §4 remove receipt (the
 * marketplace face's own ordering), then the registry row drops. Workspace
 * files an agent authored are not touched — only the roster row goes. */
const removeBundle = (registryPath) => inBand('remove', (a) => a?.name, async (args) => {
  const name = args?.name;
  const problem = specProblem(name);
  if (problem) return changeFailed('remove', String(name ?? ''), 'invalid-spec', problem);
  const installed = (await installedFromJournal(await readJournal()))
    .find((item) => item.id === name);
  const regDoc = await readRegistryDoc(registryPath);
  if (installed === undefined && registryRow(regDoc, name) === undefined) {
    return changeFailed('remove', name, 'unknown-plugin',
      `no committed install and no registry row names "${name}"`);
  }
  if (installed !== undefined) {
    await fsRemove('app', `plugins/${installed.id}@${installed.version}`,
      { recursive: true });
    const now = new Date().toISOString();
    await appendReceipt(`rm-${Date.now()}-${name}`, {
      receiptVersion: 1,
      action: 'remove',
      id: name,
      version: installed.version,
      blobSha256: installed.blobSha256,
      treeSha256: null,
      status: 'committed',
      previousVersion: installed.version,
      startedAt: now,
      committedAt: now,
    });
  }
  regDoc.plugins = regDoc.plugins.filter((row) => row?.id !== name);
  await writeRegistryDoc(registryPath, regDoc);
  log.debug('remove applied', { id: name, tree: installed !== undefined });
  return { changed: true, application: 'applied', stage: 'remove', target: name,
    bundle: name };
});

/** The shared enable leg: the registry row IS the enablement state; the
 * operation is a no-op (`changed: false`) when the row already agrees. */
const setEnabled = (stage, keyOf) => (registryPath) => inBand(stage, keyOf, async (args) => {
  const key = keyOf(args);
  const enabled = args?.enabled;
  const problem = specProblem(key) ?? (typeof enabled !== 'boolean'
    ? 'enabled must be a boolean' : null);
  if (problem) return changeFailed(stage, String(key ?? ''), 'invalid-spec', problem);
  const regDoc = await readRegistryDoc(registryPath);
  const row = registryRow(regDoc, key);
  if (row === undefined) {
    return changeFailed(stage, key, 'unknown-plugin',
      `no registry row names "${key}" (this tier manages the workspace scope only)`);
  }
  if (row.enabled === enabled) {
    log.debug('enable no-op', { stage, id: key, enabled });
    return { changed: false, application: 'applied', stage, target: key, enabled };
  }
  row.enabled = enabled;
  await writeRegistryDoc(registryPath, regDoc);
  log.debug('enable applied', { stage, id: key, enabled });
  return { changed: true, application: 'applied', stage, target: key, enabled };
});

/** inspect: the installed tree's REAL manifest (re-validated — a tree whose
 * manifest no longer validates is honestly `not-a-package`), else the
 * staged index entry (what the spec names BEFORE installing), else refused
 * `not-found`. */
const inspect = (deps) => async (args) => {
  const spec = args?.spec;
  log.debug('inspect begin', { spec });
  const problem = typeof spec === 'string' ? specProblem(spec) : 'spec must be a string';
  if (problem) return inspectRefused('invalid-spec', problem);
  const installed = (await installedFromJournal(await readJournal()))
    .find((item) => item.id === spec);
  if (installed !== undefined) return inspectInstalled(spec, installed);
  if (deps.marketplace !== undefined) {
    const staged = await inspectStaged(deps, spec);
    if (staged !== undefined) return staged;
  }
  return inspectRefused('not-found',
    `no committed install and no staged index entry names "${spec}"`);
};

/** The staged-index half of inspect: the entry the spec names before any
 * install; a catalog miss returns undefined (the caller refuses not-found),
 * any other index failure refuses `network` in-band. */
const inspectStaged = async (deps, spec) => {
  try {
    const doc = await fetchIndex({ url: deps.marketplace.indexUrl,
      fetchImpl: fetchGet, pinnedKey: deps.marketplace.publicKey });
    const entry = lookupEntry(doc, spec);
    log.debug('inspect staged entry', { id: entry.id });
    return { status: 'accepted', kind: 'registry', name: entry.id,
      version: entry.version,
      ...(entry.summary?.en === undefined ? {} : { description: entry.summary.en }),
      bundle: true };
  } catch (error) {
    if (error instanceof MarketplaceRejected && error.code === 'missing-entry') {
      return undefined;
    }
    return inspectRefused('network', `the staged index is unreadable: `
      + `${error instanceof Error ? error.message : String(error)}`);
  }
};

/** The installed-tree half of inspect: read + re-validate the promoted
 * manifest (the bytes on disk, not the receipt's echo). */
const inspectInstalled = async (spec, installed) => {
  const { decode } = await utf8Face();
  try {
    const { bytes } = await fsRead('app',
      `plugins/${spec}@${installed.version}/manifest.json`);
    const manifest = JSON.parse(decode(bytes));
    const invalid = validateManifest(manifest);
    if (invalid) {
      return inspectRefused('not-a-package',
        `the installed manifest no longer validates: ${invalid}`);
    }
    log.debug('inspect accepted', { spec, version: manifest.version });
    return { status: 'accepted', kind: 'registry', name: manifest.id,
      version: manifest.version, bundle: true };
  } catch (error) {
    return inspectRefused('not-a-package', `the installed tree is unreadable: `
      + `${error instanceof Error ? error.message : String(error)}`);
  }
};

/** cancelInstall: v1 runs no cancellable background install (no host
 * processes; each install completes inside its own handler call), so every
 * requestId names nothing — the wire's designed `not-running`. */
const cancelInstall = async (args) => {
  log.debug('cancel probed', { requestId: typeof args?.requestId });
  return { status: 'not-running' };
};

/**
 * The six pluginManager WRITE legs over the §4 pipeline + the receipts
 * journal + the workspace registry. `deps.marketplace` is the write
 * surface's VALIDATED marketplace opt-in (web-write.js deps) — absent, the
 * index-backed legs refuse in-band while the registry- and receipt-backed
 * behavior still answers.
 * @param deps - { marketplace?: {indexUrl, publicKey?} }
 * @returns the wire handlers keyed by the pluginManager method names.
 */
export const makePluginManagerWriteHandlers = (deps) => {
  log.debug('write legs assembled', { marketplace: deps?.marketplace !== undefined });
  const registryPath = registryPathOf(deps);
  return {
    installBundle: installBundle(deps),
    removeBundle: removeBundle(registryPath),
    setBundleEnabled: setEnabled('enable', (a) => a?.name)(registryPath),
    setPluginEnabled: setEnabled('enable', (a) => a?.id)(registryPath),
    inspect: inspect(deps),
    cancelInstall,
  };
};
