// dsh:logging-exempt (test scenario runner: stdout IS the product)
/**
 * toolface-relative-spelling-runner.mjs — the loop-z3 tool-face scenario.
 * Runs the REAL vendored file tools (@deepseek-ai/dsh-tool-fs `read` and
 * @deepseek-ai/dsh-tool-str-replace-editor) over the shims — the device
 * loader map applied by toolface-loader-hooks.mjs, the C seam faked over
 * real node — with the editor registered through the production seam
 * (applyWithAnchoredModelPaths, the same call boot.js's mountFileTools
 * makes). Prints one JSON line of structured facts:
 *
 *   readRelative    — the #356 control: read takes the relative `..`
 *                     spelling (fs-local resolves it against the workspace
 *                     cwd); the r14 battery measured this face PASSING and
 *                     the r16 battery found it unchanged on 105abafa.
 *   editorRelative  — the r16 v2c spelling through the ANCHORED editor:
 *                     must resolve and serve the registry content.
 *   editorRelativeAbsent — a relative spelling naming nothing: honest
 *                     absence under the root, never the vendored gate's
 *                     device-root "maybe you meant /X" suggestion.
 *   editorInside / editorOutsideExisting / editorOutsideAbsent — the
 *                     loop-v2 three forms THROUGH the tool face post-wrap.
 *   editorClimbOut  — a relative spelling climbing OUT of the root: the
 *                     loop-v2 containment gate refuses it.
 *   editorEmpty     — the vendored empty-path answer is preserved.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync as nodeStatSync, readdirSync as nodeReaddirSync, readFileSync as nodeReadFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountWorkspace } from 'upstream/shims/fs-workspace.js';
import { anchoredEditorPlugin } from '../../runtime/dsh/upstream/tool-path-anchor.js';

const { LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local');
const ToolFs = await import('@deepseek-ai/dsh-tool-fs');
const StrReplaceEditor = await import('@deepseek-ai/dsh-tool-str-replace-editor');

const root = mkdtempSync(join(tmpdir(), 'dsh-toolface-z3-'));
mountWorkspace(root);

// The battery shape (r16 v2c): root/spike is the spike tree, the registry
// lives at root/plugins/registry.json — 'dsh/../plugins/registry.json'
// climbs out of root/spike back INTO the root.
mkdirSync(join(root, 'spike'), { recursive: true });
mkdirSync(join(root, 'plugins'), { recursive: true });
writeFileSync(join(root, 'spike', 'main.js'), 'boot\n');
writeFileSync(join(root, 'plugins', 'registry.json'), '{\n  "version": 1\n}\n');

// An EXISTING directory outside the root (the /system/app sibling) and an
// absent outside spelling (the r16 v2b shape).
const outsideDir = join(tmpdir(), `dsh-toolface-z3-out-${process.pid}`, 'app');
mkdirSync(outsideDir, { recursive: true });
const outsideAbsent = join(tmpdir(), `dsh-toolface-z3-out-${process.pid}`, 'nope-xyz');

// The C seam faked over node:fs (stat/readdir/read — the fields the shim
// fallbacks read; the runner module itself speaks REAL fs for fixtures).
const statReal = (p) => {
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
globalThis.__dshProcStatReal = statReal;
globalThis.__dshProcReaddirReal = (p) => {
  try {
    return nodeReaddirSync(p);
  } catch {
    return null;
  }
};
globalThis.__dshProcReadReal = (p) => {
  try {
    return nodeReadFileSync(p).toString('base64');
  } catch {
    return null;
  }
};

const fsService = Object.create(LocalFileSystem.prototype);
fsService.config = { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 };
fsService.internals = {};
fsService.locks = new Map();

const registered = [];
const ctx = {
  fs: fsService,
  emit: () => {},
  get: () => undefined,
  inject: () => {},
  systemPrompt: { section: () => {}, getSectionOrder: () => [] },
  tools: { register: (tool) => registered.push(tool) },
};
await ToolFs.apply(ctx, { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 52428800, readStreamMinSize: 10485760 });
// The PRODUCTION registration seam (boot.js mounts the same plugin object
// via ctx.plugin) — not a test double: the editor's execute reaches the
// vendored handler with the path anchored at the mounted workspace root.
await anchoredEditorPlugin(StrReplaceEditor, root).apply(ctx);

const readTool = registered.find((t) => t.name === 'read');
const editor = registered.find((t) => t.name === 'str_replace_editor');

const drive = async (tool, args) => {
  try {
    const value = await tool.execute(args, { signal: undefined });
    // The read tool's execute resolves to an output envelope object; the
    // editor's view resolves to a rendered string. One textual form for the
    // assertions: stringify objects, keep strings verbatim.
    return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value), value };
  } catch (error) {
    return { ok: false, message: error.message, code: error.code, errno: error.errno, syscall: error.syscall };
  }
};

const facts = { root, outsideDir, outsideAbsent };

facts.readRelative = await drive(readTool, { file_path: 'dsh/../plugins/registry.json' });
facts.editorRelative = await drive(editor, { command: 'view', path: 'dsh/../plugins/registry.json' });
facts.editorRelativeAbsent = await drive(editor, { command: 'view', path: 'no-such-relative-xyz.txt' });
facts.editorInside = await drive(editor, { command: 'view', path: join(root, 'plugins', 'registry.json') });
facts.editorOutsideExisting = await drive(editor, { command: 'view', path: outsideDir });
facts.editorOutsideAbsent = await drive(editor, { command: 'view', path: outsideAbsent });
facts.editorClimbOut = await drive(editor, { command: 'view', path: '../../../../etc/passwd' });
facts.editorEmpty = await drive(editor, { command: 'view', path: '' });
// No model-reachable spelling may surface the vendored gate (and its
// device-root suggestion) on the anchored composition.
facts.gateTextSeen = [facts.editorRelative, facts.editorRelativeAbsent, facts.editorInside,
  facts.editorOutsideExisting, facts.editorOutsideAbsent, facts.editorClimbOut, facts.editorEmpty]
  .some((outcome) => !outcome.ok && outcome.message.includes('is not an absolute path'));

rmSync(root, { recursive: true, force: true });
rmSync(join(tmpdir(), `dsh-toolface-z3-out-${process.pid}`), { recursive: true, force: true });

console.log(JSON.stringify(facts));
