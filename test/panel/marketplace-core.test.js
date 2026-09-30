import { describe, it, expect } from 'vitest';
import {
  INSTALL_STEPS, installFold, installEnabled, entryRow, installedRow,
  readableInstallError, removeConfirmLine, removedLine,
} from '../../presentation/web-client-next/web/js/marketplace-core.js';

const catalogEntry = (over = {}) => ({
  id: 'dsh-office',
  version: '0.1.0',
  type: 'service',
  tgzUrl: 'https://cdn.example.com/dsh-office@0.1.0.tgz',
  blobSha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  capabilities: { required: ['fsRead', 'fsScope'], optional: ['notify'] },
  summary: { en: 'Office documents', zh: '办公文档' },
  installed: null,
  ...over,
});

describe('entryRow — the browse view of one catalog entry', () => {
  it('carries the before-download facts: id, version, caps, bilingual intro', () => {
    const row = entryRow(catalogEntry());
    expect(row.id).toBe('dsh-office');
    expect(row.version).toBe('0.1.0');
    expect(row.capsLabel).toBe('fsRead, fsScope, notify');
    expect(row.summary).toEqual({ en: 'Office documents', zh: '办公文档' });
    expect(row.installed).toBeNull();
  });

  it('reports an installed version when the catalog view annotates one', () => {
    expect(entryRow(catalogEntry({ installed: '0.1.0' })).installed).toBe('0.1.0');
  });

  it('never throws on a sparse entry (forward compatibility)', () => {
    const row = entryRow(undefined);
    expect(row.id).toBe('');
    expect(row.capsLabel).toBe('');
  });
});

describe('installEnabled — one install at a time; installed blocks re-install', () => {
  it('enables a fresh install when nothing is running', () => {
    expect(installEnabled(entryRow(catalogEntry()), null)).toBe(true);
  });
  it('disables while another install runs', () => {
    expect(installEnabled(entryRow(catalogEntry()), 'dsh-other')).toBe(false);
  });
  it('disables for an already-installed entry (v0 has no upgrade path)', () => {
    expect(installEnabled(entryRow(catalogEntry({ installed: '0.1.0' })), null)).toBe(false);
  });
});

/** One full transaction's step items, in the wire order the runtime
 * emits them (the e2e leg's fold, replayed here purely). */
const FULL_TRANSACTION = [
      { kind: 'index.verified', key: 'dsh-market-1', entries: 1 },
      { kind: 'resolved', id: 'dsh-office', version: '0.1.0', type: 'service' },
      { kind: 'fetch.start', url: 'https://cdn.example.com/dsh-office@0.1.0.tgz' },
      { kind: 'fetch.status', status: 200 },
      { kind: 'fetch.body', chunks: 7, bytes: 3584 },
      { kind: 'blob.stored', sha256: 'a'.repeat(64), bytes: 3584 },
      { kind: 'digest.verified', sha256: 'a'.repeat(64) },
      { kind: 'manifest.validated', id: 'dsh-office', version: '0.1.0' },
      { kind: 'integrity.computed', files: 2, manifestSha256: 'b'.repeat(64) },
      { kind: 'negotiated', required: 2, skipped: false },
      { kind: 'receipt.pending', txId: 'mkt-1', journal: 'receipts/journal.jsonl' },
      { kind: 'staged.verified', files: 3 },
      { kind: 'promoted', dir: 'plugins/dsh-office@0.1.0', files: 3 },
      { kind: 'committed', status: 'committed', previousVersion: null },
      { kind: 'receipt', id: 'dsh-office', version: '0.1.0', status: 'committed' },
];

describe('installFold — the D8 event stream folded into one progress line', () => {
  const fold = (items) => items.reduce(
    (state, item) => installFold(state, item),
    { steps: [], line: null, done: false, failed: false });

  it('walks the full transaction in wire order and closes at the receipt', () => {
    const state = fold(FULL_TRANSACTION);
    expect(state.steps).toEqual(INSTALL_STEPS);
    expect(state.done).toBe(true);
    expect(state.line.en).toBe('Installed dsh-office@0.1.0');
    expect(state.line.zh).toContain('已安装');
  });

  it('renders every step bilingually (the panel shows zh · en)', () => {
    for (const kind of INSTALL_STEPS.slice(0, -1)) {
      const state = installFold({ steps: [], done: false }, { kind });
      expect(state.line.en.length).toBeGreaterThan(0);
      expect(state.line.zh.length).toBeGreaterThan(0);
    }
  });

  it('renders an unknown step verbatim instead of crashing', () => {
    const state = installFold({ steps: [], done: false }, { kind: 'fetch.retry', attempt: 2 });
    expect(state.steps).toEqual(['fetch.retry']);
    expect(state.line.en).toBe('fetch.retry');
    expect(state.done).toBe(false);
  });

  it('is a pure fold: the input state is not mutated', () => {
    const before = { steps: ['fetch.start'], line: null, done: false, failed: false };
    installFold(before, { kind: 'fetch.status', status: 200 });
    expect(before.steps).toEqual(['fetch.start']);
  });

  it('tolerates a shapeless item', () => {
    const state = installFold(null, undefined);
    expect(state.steps).toEqual(['unknown']);
  });
});

describe('readableInstallError — the audit vocabulary in human words', () => {
  it('tells the signature story without hiding that nothing was installed', () => {
    const line = readableInstallError({ code: 'marketplace/signature' });
    expect(line.zh).toContain('目录签名校验失败');
    expect(line.en).toContain('nothing was installed');
  });
  it('tells the unknown-key story', () => {
    expect(readableInstallError({ code: 'marketplace/unknown-key' }).zh).toContain('密钥未知');
  });
  it('tells the integrity story (trust record mismatch, aborted)', () => {
    const line = readableInstallError({ code: 'install/integrity' });
    expect(line.zh).toContain('信任记录不符');
    expect(line.en).toContain('aborted');
  });
  it('tells the capability story (the host does not offer a required capability)', () => {
    const line = readableInstallError({ code: 'install/capability' });
    expect(line.zh).toContain('能力');
    expect(line.en).toContain('rejected');
  });
  it('keeps the network failures readable', () => {
    expect(readableInstallError({ code: 'install/network' }).zh).toContain('网络');
    expect(readableInstallError({ code: 'gateway/unavailable' }).en).toContain('reach');
  });
  it('falls back to the wire message for future codes', () => {
    const line = readableInstallError({ code: 'marketplace/some-future', message: 'details here' });
    expect(line.en).toBe('details here');
  });
});

describe('installedRow / remove copy — the journal-driven data plane', () => {
  it('shapes one installed row', () => {
    const row = installedRow({
      id: 'dsh-office', version: '0.1.0',
      committedAt: '2026-10-01T00:00:00Z',
      treeSha256: 'c'.repeat(64), dir: 'plugins/dsh-office@0.1.0',
    });
    expect(row).toEqual({
      id: 'dsh-office', version: '0.1.0',
      committedAt: '2026-10-01T00:00:00Z', dir: 'plugins/dsh-office@0.1.0',
    });
  });
  it('tolerates a sparse row', () => {
    expect(installedRow(null).committedAt).toBe('');
  });
  it('names the package and the deletion in both languages', () => {
    const row = installedRow({ id: 'dsh-office', version: '0.1.0' });
    expect(removeConfirmLine(row).zh).toContain('移除 dsh-office@0.1.0');
    expect(removeConfirmLine(row).en).toContain('deleted');
    expect(removedLine(row).zh).toContain('已移除');
  });
});
