// dsh:logging-exempt (test provisioning script: console IS the product)
/**
 * provision-vendor.mjs — the panel suite's vendored-package provisioning
 * (vitest globalSetup). The runtime modules under test import the VENDORED
 * @deepseek-ai/dsh-timeout (the #323 deadline ring arms its budgets through
 * it), and the vendor trees are UNTRACKED (gitignored, materialized by
 * runtime/spike/vendor/ensure-dsh.sh) — a fresh checkout has none, and a
 * gate that is red-by-construction there is vacuous (the run.sh #280
 * precedent). This script stages the one package the suite needs into
 * test/panel/.vendored/dsh-timeout/ from the TRACKED mirror tarball
 * (vendor/dsh-tarballs/, the D6 pin record) — or copies it from the
 * canonical materialized tree when a dev checkout already ran the ensure
 * step, so the suite always exercises the pinned 0.1.6-alpha.2 bytes.
 *
 * usage: invoked by vitest.config.js globalSetup; not run by hand.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const VERSION = '0.1.6-alpha.2';
const dst = join(here, '.vendored', 'dsh-timeout');
const setup = () => {
  const marker = join(dst, 'lib', 'index.js');
  if (existsSync(marker)) {
    console.log('provision-vendor: dsh-timeout already staged');
    return;
  }
  const canonical = join(root, 'runtime/spike/vendor/dsh', `timeout@${VERSION}`, 'lib', 'index.js');
  const tarball = join(root, 'runtime/spike/vendor/dsh-tarballs', `deepseek-ai-dsh-timeout-${VERSION}.tgz`);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(join(dst, 'lib'), { recursive: true });
  if (existsSync(canonical)) {
    copyFileSync(canonical, marker);
    console.log('provision-vendor: staged dsh-timeout from the materialized vendor tree');
  } else if (existsSync(tarball)) {
    const work = mkdtempSync(join(tmpdir(), 'dsh-panel-vendor-'));
    try {
      execFileSync('tar', ['-xzf', tarball, '-C', work], { stdio: 'inherit' });
      copyFileSync(join(work, 'package', 'lib', 'index.js'), marker);
      copyFileSync(join(work, 'package', 'package.json'), join(dst, 'package.json'));
      console.log('provision-vendor: staged dsh-timeout from the tracked mirror tarball');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } else {
    throw new Error(
      `provision-vendor: neither the materialized tree (${canonical}) nor the `
      + `tracked mirror tarball (${tarball}) exists — cannot stage @deepseek-ai/dsh-timeout`);
  }
};

export default setup;
