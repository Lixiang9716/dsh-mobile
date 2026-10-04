import { describe, it, expect, beforeEach } from 'vitest';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { makePluginManagerWriteHandlers } from 'upstream/web-write-plugin-manager.js';
import { makeCordisRunnerFace } from 'upstream/web-write-cordis.js';
import { tarWrite } from 'tar-mini.js';
import { sha256Hex } from 'sha256.js';
import { canonicalJson } from 'canonical-json.js';
import { clearIndexCache } from 'marketplace-resolver.js';
import { workspace, __httpRoute, __httpReset, __dump } from './gateway-shim.js';

// The pluginManager WRITE legs battery (#335 A1 + B3): every leg answers
// in-band — the ChangeResult refusal vocabulary on failure, never a throw
// (the #312 lesson: an exception rides the resident dispatcher's rejection
// path and kills the drive). The install leg drives the REAL §4 pipeline
// (tar bytes → sha256 → content-addressed store → manifest validation →
// promote → receipt journal commit) over the gateway shim, with the trust
// record carried from a SIGNED marketplace index (the resolver verifies it
// — node:crypto is the independent signer).

const pkcs8 = (seed) => createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der', type: 'pkcs8',
});
const SEED = Buffer.from('3a6b7d0f1e2c3b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d6e', 'hex');
const TRUSTED = pkcs8(SEED);
const PUB_B64 = Buffer.from(
  createPublicKey(TRUSTED).export({ format: 'jwk' }).x, 'base64url').toString('base64');

const INDEX_URL = 'https://market.test/index.json';
const TKG_URL = 'https://cdn.test/dsh-demo-1.0.0.tgz';

const manifest = {
  schemaVersion: 1, id: 'dsh-demo', version: '1.0.0', type: 'service',
  entry: 'main.js', capabilities: { required: [] },
};
const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
const tgz = tarWrite([
  { path: 'manifest.json', bytes: manifestBytes },
  { path: 'bundle/main.js', bytes: new TextEncoder().encode('export const dsh = 1;') },
]);

const indexDoc = () => ({
  schemaVersion: 1,
  marketplace: 'dsh',
  generatedAt: '2026-10-03T00:00:00Z',
  keys: { 'dsh-market-1': PUB_B64 },
  entries: [{
    id: 'dsh-demo', version: '1.0.0', type: 'service', tgzUrl: TKG_URL,
    blobSha256: sha256Hex(tgz), manifestSha256: sha256Hex(manifestBytes),
    capabilities: { required: [], optional: [] },
    summary: { en: 'Demo plugin', zh: '演示插件' },
  }],
  signatures: [],
});

const signedIndex = () => {
  const doc = indexDoc();
  const { signatures, ...rest } = doc;
  doc.signatures = [{
    key: 'dsh-market-1',
    value: sign(null, Buffer.from(canonicalJson(rest), 'utf-8'), TRUSTED).toString('base64'),
  }];
  return doc;
};

const seedHttp = () => {
  __httpRoute(INDEX_URL, new TextEncoder().encode(JSON.stringify(signedIndex())));
  __httpRoute(TKG_URL, tgz);
};

const seedRegistry = () => {
  workspace.set('app/plugins/registry.json', new TextEncoder().encode(JSON.stringify({
    version: 1,
    plugins: [{ id: 'countdown10', name: '10s Countdown', enabled: true }],
  })));
};

const withMarket = () => makePluginManagerWriteHandlers({
  marketplace: { indexUrl: INDEX_URL, publicKey: PUB_B64 },
});

// The #346 injected registry path: the boot derives the WORKSPACE spelling
// (`<containerRoot minus fsScopeRoot>/plugins/registry.json` — on the device
// seat `spike/plugins/registry.json`) and relays it through the write
// options; a handler family built with it must read/write the SAME document
// the LIST tier's workspace provider reads, and one built without keeps the
// app-scope-root default.
describe('the injected registry path (#346) — the write legs land where the tier reads', () => {
  it('setPluginEnabled flips the row in the INJECTED document, not the default one', async () => {
    workspace.set('app/spike/plugins/registry.json', new TextEncoder().encode(JSON.stringify({
      version: 1,
      plugins: [{ id: 'countdown10', name: '10s Countdown', enabled: true }],
    })));
    const legs = makePluginManagerWriteHandlers({ registryPath: 'spike/plugins/registry.json' });
    const res = await legs.setPluginEnabled({ id: 'countdown10', enabled: false });
    expect(res).toMatchObject({ changed: true, application: 'applied' });
    expect(__dump('app/spike/plugins/registry.json')).toBeDefined();
    expect(__dump('app/plugins/registry.json')).toBeUndefined();
    const doc = JSON.parse(new TextDecoder().decode(__dump('app/spike/plugins/registry.json')));
    expect(doc.plugins[0].enabled).toBe(false);
  });

  it('installBundle adopts into the injected document beside the §4 trees', async () => {
    seedHttp();
    const legs = makePluginManagerWriteHandlers({
      marketplace: { indexUrl: INDEX_URL, publicKey: PUB_B64 },
      registryPath: 'spike/plugins/registry.json',
    });
    const res = await legs.installBundle({ spec: 'dsh-demo' });
    expect(res).toMatchObject({ changed: true, application: 'applied', bundle: 'dsh-demo' });
    const doc = JSON.parse(new TextDecoder().decode(__dump('app/spike/plugins/registry.json')));
    expect(doc.plugins.find((row) => row.id === 'dsh-demo')).toMatchObject({ enabled: true, version: '1.0.0' });
    // the §4 machinery keeps its own plane: the tree lands at the app root
    expect(__dump('app/plugins/dsh-demo@1.0.0/manifest.json')).toBeDefined();
  });

  it('no injected path keeps the default spelling (the §4 drive seats)', async () => {
    seedRegistry();
    const res = await makePluginManagerWriteHandlers({})
      .setBundleEnabled({ name: 'countdown10', enabled: false });
    expect(res).toMatchObject({ changed: true, application: 'applied' });
    expect(__dump('app/plugins/registry.json')).toBeDefined();
  });
});

const journalReceipts = () => {
  const raw = __dump('app/receipts/journal.jsonl');
  if (raw === undefined) return [];
  return new TextDecoder().decode(raw).split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line).receipt);
};

beforeEach(() => {
  workspace.clear();
  __httpReset();
  clearIndexCache();
});

describe('pluginManager/installBundle — the workspace-scope adoption', () => {
  it('installs through the REAL §4 transaction and adopts into the registry', async () => {
    seedHttp();
    seedRegistry();
    const res = await withMarket().installBundle({ spec: 'dsh-demo' });
    expect(res).toMatchObject({ changed: true, application: 'applied',
      stage: 'install', target: 'dsh-demo', bundle: 'dsh-demo', enabled: true });
    // the commit point: a committed §4 receipt in the journal
    const receipts = journalReceipts().filter((r) => r.id === 'dsh-demo');
    expect(receipts.at(-1)).toMatchObject({ action: 'install', status: 'committed',
      version: '1.0.0' });
    // the promoted tree + the adoption row
    expect(__dump('app/plugins/dsh-demo@1.0.0/manifest.json')).toBeDefined();
    const reg = JSON.parse(new TextDecoder().decode(__dump('app/plugins/registry.json')));
    expect(reg.plugins.map((p) => p.id)).toEqual(['countdown10', 'dsh-demo']);
    expect(reg.plugins[1]).toMatchObject({ enabled: true, version: '1.0.0' });
  });

  it('honors options.enabled === false at adoption', async () => {
    seedHttp();
    const res = await withMarket().installBundle({ spec: 'dsh-demo', options: { enabled: false } });
    expect(res.enabled).toBe(false);
    const reg = JSON.parse(new TextDecoder().decode(__dump('app/plugins/registry.json')));
    expect(reg.plugins[0].enabled).toBe(false);
  });

  it('re-adoption of the committed id+version is a no-op (changed false)', async () => {
    seedHttp();
    await withMarket().installBundle({ spec: 'dsh-demo' });
    const again = await withMarket().installBundle({ spec: 'dsh-demo' });
    expect(again).toMatchObject({ changed: false, application: 'applied' });
    // one §4 transaction total: pending + committed journal entries, no second run
    expect(journalReceipts().filter((r) => r.action === 'install'
      && r.status === 'committed')).toHaveLength(1);
  });

});

describe('pluginManager/installBundle — the refusal legs (all in-band, rule 5)', () => {
  it('refuses an unknown registry name in-band (unknown-plugin)', async () => {
    seedHttp();
    const res = await withMarket().installBundle({ spec: 'dsh-nope' });
    expect(res).toMatchObject({ changed: false, application: 'failed',
      stage: 'install', target: 'dsh-nope', error: { code: 'unknown-plugin' } });
    expect(res.error.diagnostic).toContain('dsh-nope');
  });

  it('refuses a path/git/tarball spec in-band (invalid-spec)', async () => {
    seedHttp();
    const res = await withMarket().installBundle({ spec: '/tmp/dsh-demo.tgz' });
    expect(res).toMatchObject({ changed: false, application: 'failed',
      error: { code: 'invalid-spec' } });
    expect(res.error.diagnostic).toContain('bare registry names only');
  });

  it('refuses in-band with no staged package source (unaddressable)', async () => {
    const res = await makePluginManagerWriteHandlers({}).installBundle({ spec: 'dsh-demo' });
    expect(res).toMatchObject({ changed: false, application: 'failed',
      error: { code: 'unaddressable' } });
    expect(res.error.diagnostic).toContain('no package source is staged');
  });

  it('never throws — malformed args resolve into the failure shape', async () => {
    seedHttp();
    await expect(withMarket().installBundle({})).resolves.toMatchObject(
      { application: 'failed', error: { code: 'invalid-spec' } });
    await expect(withMarket().installBundle(undefined)).resolves.toMatchObject(
      { application: 'failed' });
  });
});

describe('pluginManager/removeBundle — tree, then receipt, then the row', () => {
  it('removes the committed tree, appends the §4 remove receipt, drops the row', async () => {
    seedHttp();
    seedRegistry();
    const handlers = withMarket();
    await handlers.installBundle({ spec: 'dsh-demo' });
    const res = await handlers.removeBundle({ name: 'dsh-demo' });
    expect(res).toMatchObject({ changed: true, application: 'applied',
      stage: 'remove', target: 'dsh-demo' });
    expect(__dump('app/plugins/dsh-demo@1.0.0/manifest.json')).toBeUndefined();
    const receipts = journalReceipts().filter((r) => r.id === 'dsh-demo');
    expect(receipts.at(-1)).toMatchObject({ action: 'remove', status: 'committed' });
    const reg = JSON.parse(new TextDecoder().decode(__dump('app/plugins/registry.json')));
    expect(reg.plugins.map((p) => p.id)).toEqual(['countdown10']); // agent rows survive
  });

  it('drops a registry-only row without touching agent files', async () => {
    seedRegistry();
    workspace.set('app/workspace/countdown10.js', new TextEncoder().encode('x'));
    const res = await withMarket().removeBundle({ name: 'countdown10' });
    expect(res).toMatchObject({ changed: true, application: 'applied', stage: 'remove' });
    expect(__dump('app/workspace/countdown10.js')).toBeDefined();
    const reg = JSON.parse(new TextDecoder().decode(__dump('app/plugins/registry.json')));
    expect(reg.plugins).toEqual([]);
  });

  it('refuses an unknown name in-band (unknown-plugin)', async () => {
    const res = await withMarket().removeBundle({ name: 'dsh-ghost' });
    expect(res).toMatchObject({ changed: false, application: 'failed',
      stage: 'remove', error: { code: 'unknown-plugin' } });
  });
});

describe('pluginManager/setBundleEnabled / setPluginEnabled — the registry IS the patch', () => {
  it('flips a registry row and reports the change', async () => {
    seedRegistry();
    const res = await withMarket().setBundleEnabled({ name: 'countdown10', enabled: false });
    expect(res).toMatchObject({ changed: true, application: 'applied',
      stage: 'enable', target: 'countdown10', enabled: false });
    const reg = JSON.parse(new TextDecoder().decode(__dump('app/plugins/registry.json')));
    expect(reg.plugins[0].enabled).toBe(false);
  });

  it('answers changed false when the row already agrees (no write)', async () => {
    seedRegistry();
    const res = await withMarket().setBundleEnabled({ name: 'countdown10', enabled: true });
    expect(res).toMatchObject({ changed: false, application: 'applied', enabled: true });
  });

  it('setPluginEnabled keys the same registry row by entry id', async () => {
    seedRegistry();
    const res = await withMarket().setPluginEnabled({ id: 'countdown10', enabled: false });
    expect(res).toMatchObject({ changed: true, application: 'applied',
      stage: 'enable', target: 'countdown10', enabled: false });
  });

  it('refuses an unknown row and a non-boolean enabled in-band', async () => {
    seedRegistry();
    expect(await withMarket().setBundleEnabled({ name: 'dsh-ghost', enabled: true }))
      .toMatchObject({ application: 'failed', error: { code: 'unknown-plugin' } });
    expect(await withMarket().setPluginEnabled({ id: 'countdown10', enabled: 'yes' }))
      .toMatchObject({ application: 'failed', error: { code: 'invalid-spec' } });
  });
});

describe('pluginManager/inspect — reads what the spec names', () => {
  it('accepts an installed spec from the promoted manifest on disk', async () => {
    seedHttp();
    const handlers = withMarket();
    await handlers.installBundle({ spec: 'dsh-demo' });
    expect(await handlers.inspect({ spec: 'dsh-demo' })).toEqual({
      status: 'accepted', kind: 'registry', name: 'dsh-demo', version: '1.0.0',
      bundle: true,
    });
  });

  it('accepts a staged-but-uninstalled spec from the verified index', async () => {
    seedHttp();
    expect(await withMarket().inspect({ spec: 'dsh-demo' })).toEqual({
      status: 'accepted', kind: 'registry', name: 'dsh-demo', version: '1.0.0',
      description: 'Demo plugin', bundle: true,
    });
  });

  it('refuses unknown names and non-registry specs with the problem vocabulary', async () => {
    seedHttp();
    expect(await withMarket().inspect({ spec: 'dsh-ghost' })).toMatchObject(
      { status: 'refused', problem: 'not-found' });
    expect(await withMarket().inspect({ spec: '../etc' })).toMatchObject(
      { status: 'refused', problem: 'invalid-spec' });
    expect(await withMarket().inspect(undefined)).toMatchObject(
      { status: 'refused', problem: 'invalid-spec' });
  });

  it('refuses a tampered installed tree as not-a-package', async () => {
    seedHttp();
    await withMarket().installBundle({ spec: 'dsh-demo' });
    workspace.set('app/plugins/dsh-demo@1.0.0/manifest.json',
      new TextEncoder().encode('{"schemaVersion":2}'));
    expect(await withMarket().inspect({ spec: 'dsh-demo' })).toMatchObject(
      { status: 'refused', problem: 'not-a-package' });
  });
});

describe('pluginManager/cancelInstall — v1 runs no cancellable background install', () => {
  it('answers not-running for any requestId, never throwing on junk', async () => {
    expect(await withMarket().cancelInstall({ requestId: 'pm-1' }))
      .toEqual({ status: 'not-running' });
    expect(await withMarket().cancelInstall({})).toEqual({ status: 'not-running' });
  });
});

describe('the strict registry read frames malformed documents in-band', () => {
  it('a corrupt registry answers the failure shape naming the document', async () => {
    workspace.set('app/plugins/registry.json', new TextEncoder().encode('{oops'));
    const res = await withMarket().setBundleEnabled({ name: 'countdown10', enabled: true });
    expect(res).toMatchObject({ changed: false, application: 'failed',
      error: { code: 'operation-error' } });
    expect(res.error.diagnostic).toContain('plugins/registry.json');
  });
});

describe('dynamicCordisRunner runtime-side legs (#335 B3)', () => {
  it('inventory answers the real empty roster when no runner is mounted', async () => {
    const { api } = makeCordisRunnerFace({ get: () => undefined });
    expect(await api['dynamicCordisRunner/inventory']()).toEqual([]);
  });

  it('inventory forwards to a mounted runner service instead of re-inventing', async () => {
    const rows = [{ pluginId: 'p1', agentId: 'a1', packages: [] }];
    const { api } = makeCordisRunnerFace({
      get: (name) => (name === 'dynamicCordisRunner'
        ? { inventory: async () => rows } : undefined),
    });
    expect(await api['dynamicCordisRunner/inventory']()).toBe(rows);
  });

  it('syncInspectManifest validates, records, and answers the null result', async () => {
    const face = makeCordisRunnerFace({ get: () => undefined });
    const providers = [{
      id: 'theme', description: 'Theme tokens',
      methods: [{ name: 'list', description: 'list tokens', inputSchema: null }],
    }];
    expect(await face.api['dynamicCordisRunner/syncInspectManifest']({ providers })).toBeNull();
    expect(face.syncedManifest()).toEqual(providers);
  });

  it('a malformed manifest answers the gateway bad-request envelope (the only error channel)', async () => {
    const { api } = makeCordisRunnerFace({ get: () => undefined });
    await expect(api['dynamicCordisRunner/syncInspectManifest']({ providers: 'nope' }))
      .rejects.toMatchObject({ remote: true, code: 'gateway/bad-request' });
    await expect(api['dynamicCordisRunner/syncInspectManifest']({
      providers: [{ id: '', description: 'x', methods: [] }],
    })).rejects.toMatchObject({ code: 'gateway/bad-request' });
  });
});
