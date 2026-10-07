import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync as nodeStatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mountWorkspace } from 'upstream/shims/fs-workspace.js';
import { statSync as shimStatSync } from 'upstream/shims/fs-stat.js';
import { anchorModelPath } from '../../runtime/dsh/upstream/tool-path-anchor.js';

// loop-v2 (2026-10-05): the #373 seam symmetry held on the shim faces but
// INVERTED on the model's tool face. The 2026-10-05 battery (round 14, w2,
// release 318fb22e) measured the read tool on the emulator:
//
//   (a) read of the EXISTING outside-root directory /system/app answered a
//       bare {FsError, FS_NOT_REGULAR_FILE} "not a regular file" — no
//       workspace root, no maybe-you-mean, no errno/syscall;
//   (b) read of an ABSENT outside-root path answered the FULL anchor —
//       where the promise-face contract says absence ENOENT.
//
// The composition under test is the vendored one boot.js plugs the file
// tools over (mountFileTools): tool-fs's resolveRegularReadTarget does
// `ctx.fs.resolve` (fs-local resolveLocalTarget → shim realpath) then
// `ctx.fs.stat` (fs-local probe → shim statSync) and only THEN its own
// is-regular-file pre-check (vendored tool-fs lib/index.js:273; the
// str_replace_editor family composes the same faces through statExisting,
// vendored tool-str-replace-editor lib/index.js:72). The pre-fix faces
// answered resolve+stat in the wrong order: realpath anchored the ABSENT
// outside path (fs-local rethrows non-ENOENT resolve errors raw) while
// statSync ANSWERED the existing outside directory, so the tool's own
// pre-check produced (a)'s bare shape.
//
// This suite drives the REAL vendored @deepseek-ai/dsh-fs-local — the exact
// ctx.fs surface the file tools see — in a CHILD NODE PROCESS
// (toolface-fs-local-runner.mjs) whose loader hooks
// (toolface-loader-hooks.mjs) apply the DEVICE loader's map: the vendored
// package's fs faces land on the shim family with the C seam faked over
// real node. The vitest-side shim controls pin the stat face directly.

const here = dirname(fileURLToPath(import.meta.url));
const runToolface = () => {
  const result = spawnSync(
    process.execPath,
    ['--import', './toolface-register.mjs', './toolface-fs-local-runner.mjs'],
    { cwd: here, encoding: 'utf8', timeout: 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(`toolface runner failed (${result.status}): ${result.stderr?.slice(0, 2000)}`);
  }
  return JSON.parse(result.stdout.trim().split('\n').pop());
};

const facts = runToolface();

// The shim-face controls' own world: a mounted workspace and the faked seam
// (the loop-r suite's shapes — this file keeps them self-contained so the
// fs-readdir suite's graph stays untouched).
const controlRoot = mkdtempSync(join(tmpdir(), 'dsh-toolface-controls-'));
mountWorkspace(controlRoot);
mkdirSync(join(controlRoot, 'real-child'), { recursive: true });
writeFileSync(join(controlRoot, 'real-child', 'notes.txt'), 'real\n');
const controlOutside = mkdtempSync(join(tmpdir(), 'dsh-toolface-controls-out-'));
globalThis.__dshProcStatReal = (p) => {
  try {
    const st = nodeStatSync(p);
    return {
      isDirectory: st.isDirectory(),
      isFile: st.isFile(),
      isSymbolicLink: st.isSymbolicLink(),
      size: Number(st.size),
      mode: Number(st.mode),
      mtimeMs: Math.trunc(Number(st.mtimeMs)),
    };
  } catch {
    return null;
  }
};

afterAll(() => {
  delete globalThis.__dshProcStatReal;
  rmSync(controlRoot, { recursive: true, force: true });
  rmSync(controlOutside, { recursive: true, force: true });
});

describe('the tool face answers outside-root reads in the seam order (loop-v2)', () => {
  it('(a) an existing outside-root directory refuses with the anchor — never a type answer', () => {
    // Pre-fix, ctx.fs.stat ANSWERED {type:'directory'} here and the tool's
    // own is-regular-file pre-check produced the bare FS_NOT_REGULAR_FILE.
    // The refusal must happen INSIDE ctx.fs.stat — before that pre-check.
    expect(facts.a.threw).toBe(true);
    expect(facts.a.message).toContain('outside the writable workspace root');
    expect(facts.a.message).toContain(facts.root);
    expect(facts.a.message).toContain('maybe you meant');
    // The unified #373 shape rides raw (fs-local's probeStats rethrows
    // non-ENOENT as-is): the node-complete fields the panel pins on the
    // read faces.
    expect(facts.a.code).toBe('EACCES');
    expect(facts.a.errno).toBe(-13);
    expect(facts.a.syscall).toBe('stat');
  });

  it('(b) an absent outside-root path resolves and stats absent — the FS_NOT_FOUND handoff', () => {
    // Pre-fix, the ANCHOR rode the resolve (vfsRealpath refused the absent
    // outside path; fs-local rethrows non-ENOENT raw). The ENOENT now sends
    // fs-local down its ancestor walk instead, and stat → undefined is
    // exactly what tool-fs's resolveRegularReadTarget and str_replace_
    // editor's statExisting map to their FS_NOT_FOUND absence answers.
    expect(facts.b.resolveOk).toBe(true);
    expect(facts.b.stat.threw).toBe(false);
    expect(facts.b.stat.info).toBeNull();
  });

  it('(c) a real inside-root directory still answers and lists (unchanged)', () => {
    expect(facts.c.stat.threw).toBe(false);
    expect(facts.c.stat.info?.type).toBe('directory');
    expect(facts.c.listingNames).toContain('notes.txt');
  });
});

describe('the stat face holds the seam boundary (loop-v2, shim-face controls)', () => {
  it('refuses a real outside-root directory with the anchor, never a type answer', () => {
    let error;
    try {
      shimStatSync(controlOutside);
      expect.unreachable('the outside-root stat must refuse');
    } catch (caught) {
      error = caught;
    }
    expect(error.message).toContain('outside the writable workspace root');
    expect(error.message).toContain(controlRoot);
    expect(error.message).toContain('maybe you meant');
    expect(error.code).toBe('EACCES');
    expect(error.errno).toBe(-13);
    expect(error.syscall).toBe('stat');
  });

  it('keeps node-absence (ENOENT) for an outside-root path the host does not hold', () => {
    let error;
    try {
      shimStatSync(join(tmpdir(), 'dsh-toolface-absent-nowhere', 'no-such.txt'));
      expect.unreachable('the absent stat must throw');
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('ENOENT');
    expect(error.syscall).toBe('stat');
  });

  it('still answers real INSIDE-root entries the served views never registered (W6-V children)', () => {
    const shape = shimStatSync(join(controlRoot, 'real-child', 'notes.txt'));
    expect(shape.isFile()).toBe(true);
  });
});

// loop-z3 (2026-10-05): the r16 battery (v2c) measured the model's
// str_replace_editor refusing the in-root relative spelling
// 'dsh/../plugins/registry.json' at the VENDORED absolute-path gate
// (resolveTarget, vendored tool-str-replace-editor lib/index.js:69) with a
// "maybe you meant /dsh/..." suggestion whose leading / is the DEVICE root
// — driving the suggestion answered FS_NOT_FOUND (v2c2). The queue line
// suspected the #380 seam re-order; the r14→r16 delta is actually the TOOL
// the model picked (r14's w2c drove `read`, whose fs-local resolve accepts
// relative spellings against the workspace cwd — the #356 semantics — and
// the probe run on 105abafa shows it still passing), while the editor's gate
// is upstream and byte-identical since it was vendored. The defect is real
// either way: one model face accepts the workspace-relative directory
// language the other refuses, and the refusal teaches a dead end.
//
// The fix anchors the editor's model-supplied `path` at the mounted
// workspace root BEFORE the vendored handler runs (applyWithAnchoredModelPaths
// — the exact call boot.js's mountFileTools now makes). Normalization first,
// inside/outside + existence second: in-root relative spellings resolve,
// out-of-root climbs still refuse at the loop-v2 containment gate, absolute
// spellings pass byte-identical, and the gate (with its device-root
// suggestion) is unreachable for model input.
describe('the model-path anchor (loop-z3, unit)', () => {
  it('passes absolute spellings through byte-identical', () => {
    const root = '/data/user/0/com.dshmobile.host/files/profiles/default/dsh';
    expect(anchorModelPath(`${root}/plugins/registry.json`, root)).toBe(`${root}/plugins/registry.json`);
    expect(anchorModelPath(`${root}/dsh/../plugins/registry.json`, root))
      .toBe(`${root}/dsh/../plugins/registry.json`);
  });

  it('joins relative spellings at the root verbatim (physical .., no normalization)', () => {
    const root = '/data/user/0/com.dshmobile.host/files/profiles/default/dsh';
    expect(anchorModelPath('dsh/../plugins/registry.json', root))
      .toBe(`${root}/dsh/../plugins/registry.json`);
    expect(anchorModelPath('../../etc/passwd', root)).toBe(`${root}/../../etc/passwd`);
  });

  it('leaves empty and non-string inputs so the vendored gate keeps its own answers', () => {
    const root = '/ws';
    expect(anchorModelPath('', root)).toBe('');
    expect(anchorModelPath(undefined, root)).toBe(undefined);
  });
});

const runRelativeSpelling = () => {
  const result = spawnSync(
    process.execPath,
    ['--import', './toolface-register.mjs', './toolface-relative-spelling-runner.mjs'],
    { cwd: here, encoding: 'utf8', timeout: 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(`relative-spelling runner failed (${result.status}): ${result.stderr?.slice(0, 2000)}`);
  }
  return JSON.parse(result.stdout.trim().split('\n').pop());
};

const z3 = runRelativeSpelling();

describe('the editor face answers relative spellings like the read face (loop-z3)', () => {
  it('the read-face control: read resolves the relative .. spelling (unchanged)', () => {
    expect(z3.readRelative.ok).toBe(true);
    // The read tool's execute resolves to its line-window envelope — the
    // served lines carry the registry content.
    const lines = z3.readRelative.value?.lines?.map((line) => line.text) ?? [];
    expect(lines.join('\n')).toContain('"version": 1');
    expect(z3.readRelative.text).toContain('plugins/registry.json');
  });

  it('the r16 v2c spelling resolves through the anchored editor and serves the registry', () => {
    expect(z3.editorRelative.ok).toBe(true);
    expect(z3.editorRelative.text).toContain('"version": 1');
    expect(z3.editorRelative.text).toContain(z3.root);
  });

  it('a relative absent spelling answers honest absence — never the device-root suggestion', () => {
    expect(z3.editorRelativeAbsent.ok).toBe(false);
    expect(z3.editorRelativeAbsent.message).toContain('does not exist');
    expect(z3.editorRelativeAbsent.message).toContain(z3.root);
    expect(z3.editorRelativeAbsent.message).not.toContain('is not an absolute path');
    expect(z3.editorRelativeAbsent.message).not.toContain('Maybe you meant');
  });

  it('the vendored absolute-path gate is unreachable for every driven spelling', () => {
    expect(z3.gateTextSeen).toBe(false);
  });

  it('the vendored empty-path answer is preserved', () => {
    expect(z3.editorEmpty.ok).toBe(false);
    expect(z3.editorEmpty.message).toContain('path must be a non-empty string');
  });
});

describe('the loop-v2 three forms hold through the tool face post-wrap (loop-z3)', () => {
  it('(a) an existing outside-root directory refuses with the anchor', () => {
    expect(z3.editorOutsideExisting.ok).toBe(false);
    expect(z3.editorOutsideExisting.message).toContain('outside the writable workspace root');
    expect(z3.editorOutsideExisting.message).toContain(z3.root);
    expect(z3.editorOutsideExisting.message).toContain('maybe you meant');
    expect(z3.editorOutsideExisting.code).toBe('EACCES');
    expect(z3.editorOutsideExisting.errno).toBe(-13);
    expect(z3.editorOutsideExisting.syscall).toBe('stat');
  });

  it('(b) an absent outside-root path answers plain absence', () => {
    expect(z3.editorOutsideAbsent.ok).toBe(false);
    expect(z3.editorOutsideAbsent.message).toContain('does not exist');
    expect(z3.editorOutsideAbsent.code).toBe('FS_NOT_FOUND');
  });

  it('(c) an inside-root absolute spelling resolves and serves, byte-identical semantics', () => {
    expect(z3.editorInside.ok).toBe(true);
    expect(z3.editorInside.text).toContain('"version": 1');
  });

  it('a relative spelling climbing OUT of the root refuses at the containment gate', () => {
    expect(z3.editorClimbOut.ok).toBe(false);
    expect(z3.editorClimbOut.message).toContain('outside the writable workspace root');
    expect(z3.editorClimbOut.code).toBe('EACCES');
  });
});
