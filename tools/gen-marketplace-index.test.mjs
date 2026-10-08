// dsh:logging-exempt (test file: assertions ARE the product)
/**
 * gen-marketplace-index.test.mjs — the signed catalog's data-level net
 * (tools/gen-marketplace-index.mjs).
 *
 * The generator fails loud (rule 5) the moment a system plugin lacks its
 * deploy/marketplace/summaries.json row — found the honest way on
 * 2026-10-08, when the device-verification round's marketplace cycle could
 * not build a catalog: dsh-plugin-manager-tools (added 2026-10-04) had no
 * summary row, so EVERY publish run aborted mid-flight. This suite pins the
 * invariant at the data level so the next plugin lands with its row: every
 * system-plugins/<pkg> carrying a manifest.json must have a summaries row
 * with non-empty en AND zh strings — the exact demand the generator's
 * fail-loud makes. Also pins the shape the resolver's display face reads
 * (each summary is exactly {en, zh}).
 *
 * Offline and hermetic: reads the repo's own files, writes nothing.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const PLUGINS = join(REPO, 'system-plugins');
const SUMMARIES = join(REPO, 'deploy', 'marketplace', 'summaries.json');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('marketplace catalog summaries cover every system plugin', () => {
  const summaries = readJson(SUMMARIES);
  const pluginDirs = readdirSync(PLUGINS).filter((name) =>
    existsSync(join(PLUGINS, name, 'manifest.json')));

  it('there are system plugins to cover (the suite guards a real surface)', () => {
    expect(pluginDirs.length).toBeGreaterThan(0);
  });

  it('every system plugin has a summaries row with non-empty en and zh', () => {
    const missing = pluginDirs.filter((name) => summaries[name] === undefined);
    expect(missing, `deploy/marketplace/summaries.json has no row for: ${missing.join(', ')}`
      + ' — gen-marketplace-index.mjs aborts the publish on exactly this gap').toEqual([]);
    for (const name of pluginDirs) {
      for (const lang of ['en', 'zh']) {
        expect(typeof summaries[name]?.[lang], `${name}.${lang}`).toBe('string');
        expect(summaries[name][lang].trim().length, `${name}.${lang}`).toBeGreaterThan(0);
      }
    }
  });

  it('every summary row is exactly {en, zh} (the frozen display shape)', () => {
    for (const [name, row] of Object.entries(summaries)) {
      expect(Object.keys(row).sort(), name).toEqual(['en', 'zh']);
    }
  });
});
