import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync as nodeReaddirSync, readFileSync as nodeReadFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountWorkspace } from 'upstream/shims/fs-workspace.js';
import { readdirSync, writeFileSync as wsWriteFileSync, mkdirSync as wsMkdirSync, readFileSync, readAnyBytes, realpathSync } from 'upstream/shims/fs.js';
import { readFile } from 'upstream/shims/fs-promises.js';

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

// loop-r fixtures: real trees OUTSIDE the mounted root, in the shapes the
// 2026-10-04 battery proved the model seat could read. The system-tree shape
// (a /system/app sibling branch), and the credential shape (a sibling branch
// of the root holding an llm config — the S4 topology where the workspace
// root is <scope>/dsh and the key sits at <scope>/llm/config.json).
const systemApp = join(tmpdir(), `dsh-fs-system-${process.pid}`);
mkdirSync(systemApp, { recursive: true });
writeFileSync(join(systemApp, 'BasicDreams.apk'), 'apk\n');
writeFileSync(join(systemApp, 'Traceur.apk'), 'apk\n');
const secretBranch = mkdtempSync(join(tmpdir(), 'dsh-fs-secret-'));
mkdirSync(join(secretBranch, 'llm'), { recursive: true });
const SECRET = '{"baseUrl":"https://example.invalid","apiKey":"sk-secret-loop-r"}\n';
writeFileSync(join(secretBranch, 'llm', 'config.json'), SECRET);

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
// Seam-only bytes (the W5-R marker-file shape): a file the host disk does
// NOT have, delivered through the read seam — how the loop-r suite pins the
// promise-face readFile arm (under vitest the fs-promises module's
// node:fs imports are REAL node, so only a seam-served miss reaches the
// shim's own fallback arm).
const seamOnlyFiles = new Map();
const readReal = (p) => seamOnlyFiles.get(p) ?? (() => {
  try {
    return nodeReadFileSync(p).toString('base64');
  } catch {
    return null;
  }
})();
globalThis.__dshProcStatReal = statReal;
globalThis.__dshProcReaddirReal = readdirReal;
globalThis.__dshProcReadReal = readReal;

afterAll(() => {
  delete globalThis.__dshProcStatReal;
  delete globalThis.__dshProcReaddirReal;
  delete globalThis.__dshProcReadReal;
  seamOnlyFiles.clear();
  rmSync(root, { recursive: true, force: true });
  rmSync(systemApp, { recursive: true, force: true });
  rmSync(secretBranch, { recursive: true, force: true });
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

describe('outside-root refusals teach the anchor (loop-h)', () => {
  it('the write refusal names the workspace root and the correct spelling', () => {
    try {
      wsWriteFileSync('/plugins/thing.js', new TextEncoder().encode('x\n'));
      expect.unreachable('the outside-root write must refuse');
    } catch (error) {
      expect(error.message).toContain('outside the writable workspace root');
      expect(error.message).toContain(root);
      expect(error.message).toContain(`'${root}/plugins/thing.js'`);
    }
  });

  it('the mkdir refusal carries the same anchor', () => {
    expect(() => wsMkdirSync('/plugins')).toThrow(/the writable workspace root is '/);
  });
});

// loop-r: the real-disk READ seam (stat/read/readdir fallbacks over the C
// host's __dshProc*Real) answered absolute paths OUTSIDE the pinned root —
// the model seat's fs scope had no observable "outside": the battery seat
// listed /data/data/.../files/profiles and /system/app verbatim and could
// have read the staged llm config. The seam is bound to the workspace; an
// outside-root answer is the #358 anchor refusal in-band.
describe('the real-disk seam answers the workspace only (loop-r)', () => {
  it('still lists real INSIDE-root directories — served ∪ real (the S3/loop-p baseline)', () => {
    const names = readdirSync(join(root, 'plugins'), { withFileTypes: true });
    expect(names.map((d) => d.name)).toContain('countdown-timer');
  });

  it('refuses to list a real /system/app-shaped tree outside the root, with the anchor', () => {
    let error;
    try {
      readdirSync(systemApp);
      expect.unreachable('the outside-root listing must refuse');
    } catch (caught) {
      error = caught;
    }
    expect(error.message).toContain('outside the writable workspace root');
    expect(error.message).toContain(root);
    expect(error.message).toContain('maybe you meant');
    // The real names never ride the refusal or any listing.
    expect(error.message).not.toContain('BasicDreams');
    // Codeless on purpose: fs-local's listingIoError rewrites ENOENT/EACCES
    // to bare 'not found'/'permission denied' — only a codeless error rides
    // the generic IO_ERROR arm that carries the message to the model.
    expect(error.code).toBeUndefined();
  });

  it('refuses to read a real file from an outside-root tree', () => {
    expect(() => readFileSync(join(systemApp, 'BasicDreams.apk'))).toThrow(/outside the writable workspace root/);
  });

  it('an outside-root path that does not exist anywhere stays node-absent (ENOENT)', () => {
    let error;
    try {
      readdirSync(join(tmpdir(), `dsh-fs-absent-${process.pid}`));
      expect.unreachable('the absent readdir must throw');
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('ENOENT');
    // Absence still teaches the root (message-level), keeping the
    // discovery-walk code contract (fs-readdir.js: isAbsentSkillPathError).
    expect(error.message).toContain('maybe you meant');
  });
});

describe('the model seat cannot read the staged credential (loop-r)', () => {
  it('the llm config (sibling branch of the root) is inside the refusal zone — bytes never served', () => {
    const configPath = join(secretBranch, 'llm', 'config.json');
    expect(() => readFileSync(configPath, 'utf8')).toThrow(/outside the writable workspace root/);
    // The anchor refusal is not a smuggling channel: the message names the
    // path, never the content.
    let message = '';
    try {
      readFileSync(configPath, 'utf8');
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('maybe you meant');
    expect(message).not.toContain('sk-secret-loop-r');
  });

  it('the promise readFile arm refuses a seam-served outside-root file with the anchor', async () => {
    const outsideSeamPath = join(tmpdir(), `dsh-fs-seam-${process.pid}`, 'marker.txt');
    seamOnlyFiles.set(outsideSeamPath, Buffer.from('child wrote this\n').toString('base64'));
    await expect(readFile(outsideSeamPath, 'utf8')).rejects.toThrow(/outside the writable workspace root/);
    await expect(readFile(outsideSeamPath, 'utf8')).rejects.toThrow(/maybe you meant/);
  });

  it('the promise readFile arm still serves the W5-R marker inside the root', async () => {
    const insideSeamPath = join(root, 'markers', 'child-done.txt');
    seamOnlyFiles.set(insideSeamPath, Buffer.from('done\n').toString('base64'));
    const text = await readFile(insideSeamPath, 'utf8');
    expect(text).toBe('done\n');
  });
});

// loop-w: the #363-review follow-ups — the unmounted-workspace hint degrade,
// the absence-shape symmetry across the read faces, and the lexical refusal
// spellings.
describe('unmounted-workspace hints degrade to empty (loop-w)', () => {
  it('readdirSync outside-root with NO workspace mounted answers absence, not a mount error', () => {
    const saved = globalThis.__DSH_WORKSPACE_FS__;
    globalThis.__DSH_WORKSPACE_FS__ = null;
    try {
      let error;
      try {
        readdirSync('/no-workspace-mounted/no-such-dir');
        expect.unreachable('the unmounted readdir must throw');
      } catch (caught) {
        error = caught;
      }
      // The pre-fix answer here was the mount error (wsRootHint's ws() call)
      // masking the ENOENT the discovery walks branch on — the same
      // degrade-to-empty principle fs-seam-gate already holds.
      expect(error.code).toBe('ENOENT');
      expect(error.message).not.toContain('not mounted');
    } finally {
      globalThis.__DSH_WORKSPACE_FS__ = saved;
    }
  });

  it('the seam-gate refusal with no workspace mounted still refuses, hint-free', () => {
    const saved = globalThis.__DSH_WORKSPACE_FS__;
    globalThis.__DSH_WORKSPACE_FS__ = null;
    try {
      let error;
      try {
        readFileSync('/no-workspace-mounted/secret.txt', 'utf8');
        expect.unreachable('the unmounted outside read must refuse');
      } catch (caught) {
        error = caught;
      }
      expect(error.code).toBe('EACCES');
      expect(error.message).toContain('outside the writable workspace root');
      expect(error.message).not.toContain('not mounted');
    } finally {
      globalThis.__DSH_WORKSPACE_FS__ = saved;
    }
  });
});

describe('outside-root absence answers ENOENT on every read face (loop-w)', () => {
  it('the promise readFile arm answers ENOENT for an outside-root path that exists nowhere', async () => {
    const absent = join(tmpdir(), `dsh-fs-absent-${process.pid}`, 'no-such.txt');
    let error;
    try {
      await readFile(absent, 'utf8');
      expect.unreachable('the absent read must throw');
    } catch (caught) {
      error = caught;
    }
    // Symmetric with readdirMiss: the anchor is for a path the host disk
    // actually holds; genuine absence keeps the discovery-walk ENOENT.
    expect(error.code).toBe('ENOENT');
    expect(error.message).not.toContain('outside the writable workspace root');
  });
});

describe('refusal spellings are lexical (loop-w)', () => {
  it('the sync readFileSync refusal carries the lexical spelling, not raw ../ hops', () => {
    // String-built on purpose: node's join would lexicalize the '..' hop
    // before the shim ever sees it.
    const raw = `${systemApp}/no-such/../BasicDreams.apk`;
    let error;
    try {
      readFileSync(raw, 'utf8');
      expect.unreachable('the outside read must refuse');
    } catch (caught) {
      error = caught;
    }
    expect(error.message).toContain('outside the writable workspace root');
    // The lexical spelling is refused; the raw '..' hop never teaches the
    // model a wrong maybe-you-meant.
    expect(error.message).toContain(`${systemApp}/BasicDreams.apk`);
    expect(error.message).not.toContain('/../');
    expect(error.message).toContain(`'${root}${systemApp}/BasicDreams.apk'`);
    // The one refusal shape: node-complete fields on both factories.
    expect(error.code).toBe('EACCES');
    expect(error.errno).toBe(-13);
    expect(error.syscall).toBe('readFileSync');
  });

  it('readAnyBytes refusal is lexical too', () => {
    const raw = `${systemApp}/no-such/../BasicDreams.apk`;
    let error;
    try {
      readAnyBytes(raw);
      expect.unreachable('the outside read must refuse');
    } catch (caught) {
      error = caught;
    }
    expect(error.message).toContain('outside the writable workspace root');
    expect(error.message).not.toContain('/../');
  });
});

describe('the outside-root refusal carries one shape (loop-w)', () => {
  // loop-v2 (2026-10-05) flipped this face: the pre-fix pin held the anchor
  // (EACCES) for an outside-root ABSENT path — the other half of the field
  // inversion (the tool face answered the anchor here while an EXISTING
  // outside directory got a bare not-a-regular-file). Absence on every face
  // now stays the node ENOENT the #373 symmetry standardised; the anchor
  // moved to what the host actually holds (fs-stat.js's stat face; the read
  // faces above keep theirs).
  it('realpathSync outside-root absent path answers node-absence (ENOENT), not the anchor', () => {
    let error;
    try {
      realpathSync(join(tmpdir(), `dsh-fs-absent-${process.pid}`, 'no-such.txt'));
      expect.unreachable('the outside absent realpath must throw');
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('ENOENT');
    expect(error.errno).toBe(-2);
    expect(error.syscall).toBe('realpath');
    expect(error.message).not.toContain('outside the writable workspace root');
  });

  it('realpathSync outside-root path the host holds still canonicalizes (the ancestor-walk arm)', () => {
    // The answering arm stays: fs-local's resolve ENOENT walk realpaths the
    // nearest existing ancestor — an outside-root REAL directory — and the
    // tool face's refusal happens one face later (stat), not here.
    expect(realpathSync(join(tmpdir(), `dsh-fs-system-${process.pid}`))).toBe(join(tmpdir(), `dsh-fs-system-${process.pid}`));
  });
});
