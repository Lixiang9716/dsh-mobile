import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync as nodeReaddirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountWorkspace } from 'upstream/shims/fs-workspace.js';
import { readdirSync, writeFileSync as wsWriteFileSync } from 'upstream/shims/fs.js';

// loop-p (round 4): the model's str_replace_editor view of a REAL workspace
// directory answered `cannot list …: not found` while reads of the same
// tree's files worked. The served workspace view lists only REGISTERED
// entries; the real-disk readdir fallback needed the desktop-only
// subprocess namespace (find), inert on every device seat. The C host now
// carries __dshProcReaddirReal, and the fallback prefers it. This suite
// pins the fallback with the seam faked over node:fs — exactly the
// desktop-host shape the fallback targets.

const root = mkdtempSync(join(tmpdir(), 'dsh-fs-readdir-'));
mountWorkspace(root);

// A real tree the served VFS never registered — the "parent/child wrote it"
// scenario (the plugin installer's write-through mirror lands here).
mkdirSync(join(root, 'plugins'), { recursive: true });
mkdirSync(join(root, 'plugins', 'countdown-timer'));
writeFileSync(join(root, 'plugins', 'countdown-timer', 'index.js'), 'export {};\n');

// The seam fakes over node:fs: real paths in, real answers out. The C
// host's face is plain-booleans (isDirectory/isFile/isSymbolicLink as
// booleans) plus size — names-only readdir, "." and ".." skipped, null
// when absent.
const statReal = (p) => {
  try {
    const st = statSync(p);
    return {
      isDirectory: st.isDirectory(),
      isFile: st.isFile(),
      isSymbolicLink: st.isSymbolicLink(),
      size: Number(st.size),
    };
  } catch {
    return null;
  }
};
const readdirReal = (p) => {
  try {
    return nodeReaddirSync(p);
  } catch {
    return null;
  }
};
globalThis.__dshProcStatReal = statReal;
globalThis.__dshProcReaddirReal = readdirReal;

afterAll(() => {
  delete globalThis.__dshProcStatReal;
  delete globalThis.__dshProcReaddirReal;
  rmSync(root, { recursive: true, force: true });
});

describe('fs readdir real-disk fallback (loop-p)', () => {
  it('lists a real, unregistered workspace directory through the seam', () => {
    const names = readdirSync(join(root, 'plugins', 'countdown-timer'));
    expect(names).toContain('index.js');
  });

  it('shapes Dirents for withFileTypes (the fs-local listDir face)', () => {
    const dirents = readdirSync(join(root, 'plugins', 'countdown-timer'), { withFileTypes: true });
    expect(dirents.map((d) => d.name)).toContain('index.js');
    expect(dirents.find((d) => d.name === 'index.js').isFile()).toBe(true);
  });

  it('lists the real directory as a child of its real parent', () => {
    const dirents = readdirSync(join(root, 'plugins'), { withFileTypes: true });
    const row = dirents.find((d) => d.name === 'countdown-timer');
    expect(row).toBeDefined();
    expect(row.isDirectory()).toBe(true);
  });

  it('still lists served-registry entries beside real ones', () => {
    wsWriteFileSync(join(root, 'served.txt'), new TextEncoder().encode('served\n'));
    const names = readdirSync(root);
    expect(names).toContain('served.txt');
    expect(names).toContain('plugins');
  });

  it('answers absence for a directory that does not exist anywhere', () => {
    expect(() => readdirSync(join(root, 'no-such-branch'))).toThrow(/ENOENT|no such/);
  });
});
