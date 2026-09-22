// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * tool-fs-probe.js — the FILE-TOOLS row (the dsh-desktop fs tool family),
 * driven the way the panel will drive it: the vendored @deepseek-ai/dsh-fs-local
 * backend mounted as `ctx.fs` over a pinned in-memory workspace, with the
 * vendored @deepseek-ai/dsh-tool-fs (`read`/`write`/`edit`) and
 * @deepseek-ai/dsh-tool-str-replace-editor (`str_replace_editor`:
 * view/create/str_replace/insert) registering into the existing ToolRuntime.
 *
 * NOT an E2E manifest fixture: this is the composition probe for the
 * 完全接入 dsh-desktop 插件 work. boot.js does NOT mount the row yet — this
 * probe builds the composition itself (the presets-probe pattern) and every
 * step asserts its expected value inline before logging got+want as one
 * record, so the scenario stream is a one-to-one expected↔logged match under
 * the unique scenario id `tool.fs`.
 *
 * Import order matters twice:
 *   1. `upstream/boot.js` first — its web-shims prelude must evaluate before
 *      any vendored module (cordis et al) loads;
 *   2. `upstream/shims/npm-bridges.js` must EVALUATE before the tool
 *      packages RESOLVE — ESM links a static import graph before any module
 *      body runs, so a statically imported tool-fs would demand the bare
 *      `diff` specifier before the bridge exists. The tool packages (and
 *      fs-local, whose `Config` static evaluates `process.cwd()` at module
 *      load — only answerable after bootUpstream pins the container) are
 *      therefore imported DYNAMICALLY inside main().
 */
import { bootUpstream } from 'upstream/boot.js';
import 'upstream/shims/npm-bridges.js';
import { mountWorkspace } from 'upstream/shims/fs.js';
import { createLogger } from 'logger.js';

const SCENARIO = 'tool.fs';
const log = createLogger('tool-fs.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });

const WORKSPACE = '/workspace';
const NOTES = `${WORKSPACE}/notes`;
const NOTES_MD = `${NOTES}/notes.md`;

/** Fail loud naming what diverged (rule 5); the caller logs got+want. */
const expectEq = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${SCENARIO}: ${what} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

/** One tool call through the REAL ToolRuntime dispatch (guards, policies,
 * result materialization), returning the materialized result. The runtime
 * reads `exec.signal` unconditionally, so each call carries a fresh,
 * never-aborted signal — the same shape a dispatching agent loop builds. */
const call = async (name, args) => await ctx.tools.execute({
  name,
  arguments: args,
  callId: `${SCENARIO}.${name}`,
  signal: new AbortController().signal,
});

/** Assert the outcome is a success and return its structured value. */
const valueOf = (name, outcome) => {
  if (outcome.isError === true) {
    throw new Error(`${SCENARIO}: ${name} failed — ${JSON.stringify(outcome.error ?? outcome.content ?? outcome).slice(0, 400)}`);
  }
  return outcome.value;
};

const main = async () => {
  log.debug('scenario start', { name: SCENARIO });

  // The row's world: ONE pinned in-memory workspace root (the mount that
  // boot.js will own once the row ships in the product boot).
  mountWorkspace(WORKSPACE);
  emit('workspace', { root: WORKSPACE, engine: 'in-memory VFS (upstream/shims/fs.js)' });

  const { ctx: booted } = await bootUpstream({
    scenario: SCENARIO,
    agentId: 'probe-agent',
    sessionId: 'probe-session',
    cwd: WORKSPACE,
    onEvent: emit,
    container: {
      cwd: WORKSPACE,
      tmpdir: `${WORKSPACE}/tmp`,
      home: `${WORKSPACE}/home`,
      scopeRoot: WORKSPACE,
      env: {},
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: 'http://127.0.0.1:1', apiKey: 'probe', provider: 'mock', model: 'mock-1',
    },
  });
  ctx = booted;

  // ---- THE FILE-TOOLS ROW ------------------------------------------------
  // The row now mounts INSIDE boot.js's mountSpine (the product boot owns
  // it): the fs-local backend over the container cwd passed above, plus the
  // file tools. This probe verifies the mounted truth instead of mounting a
  // second copy — cordis refuses a second `fs` registration, by design.
  const fs = ctx.get('fs');
  expectEq('fs service mounted', fs !== undefined, true);
  expectEq('fs backend class', fs?.constructor?.name, 'LocalFileSystem');
  const toolNames = ['read', 'write', 'edit', 'str_replace_editor']
    .map((name) => ctx.tools.get(name) !== undefined);
  expectEq('tools registered', toolNames, [true, true, true, true]);
  emit('mounted', {
    fs: 'LocalFileSystem (vendored @deepseek-ai/dsh-fs-local) under ctx.fs',
    tools: ['read', 'write', 'edit', 'str_replace_editor'],
    readImageMounted: ctx.tools.get('read_image') !== undefined,
  });

  await exerciseFileTools();
};

/** The tool-call ladder (split from main at the file-size gate): the
 * seven one-to-one assertions over the REAL tool dispatch. */
const exerciseFileTools = async () => {
  // 1. CREATE — str_replace_editor `create` (the write path with the
  //    createIfAbsent intent: stage → hard-link no-replace → publish).
  const created = valueOf('create', await call('str_replace_editor', {
    command: 'create',
    path: NOTES_MD,
    file_text: 'alpha line\nbeta line\ngamma line\n',
  }));
  expectEq('create result', created, `New file created successfully at: ${NOTES_MD}`);
  emit('create', { path: NOTES_MD, result: created });

  // 2. READ — the tool-fs `read` window (line numbers, totalLines).
  const read1 = valueOf('read', await call('read', { file_path: NOTES_MD }));
  expectEq('read path', read1.path, NOTES_MD);
  expectEq('read totalLines', read1.totalLines, 3);
  expectEq('read line 1', read1.lines[0], { number: 1, text: 'alpha line' });
  expectEq('read line 3', read1.lines[2], { number: 3, text: 'gamma line' });
  emit('read', {
    path: read1.path, totalLines: read1.totalLines, lines: read1.lines,
  });

  // 3. WRITE — the tool-fs `write` full-file overwrite; the outcome carries
  //    the create/update verb and the pre-write diff basis.
  const write1 = valueOf('write', await call('write', {
    file_path: NOTES_MD,
    content: 'alpha line\nbeta v2 line\ngamma line\n',
  }));
  expectEq('write path', write1.path, NOTES_MD);
  expectEq('write operation', write1.operation, 'update');
  expectEq('write diff basis (before)', write1.before, 'alpha line\nbeta line\ngamma line\n');
  emit('write', { path: write1.path, operation: write1.operation, beforeIsOldContent: write1.before === 'alpha line\nbeta line\ngamma line\n' });

  await ladderTail();
};

/** Ladder tail: the remaining file-tool assertions (split at the size
 * gate). */
const ladderTail = async () => {
  // 4. EDIT — the tool-fs `edit` literal replacement.
  const edit1 = valueOf('edit', await call('edit', {
    file_path: NOTES_MD,
    old_string: 'beta v2 line',
    new_string: 'beta v3 line',
  }));
  expectEq('edit before', edit1.before, 'alpha line\nbeta v2 line\ngamma line\n');
  expectEq('edit after', edit1.after, 'alpha line\nbeta v3 line\ngamma line\n');
  emit('edit', { path: NOTES_MD, oldString: 'beta v2 line', newString: 'beta v3 line', applied: edit1.after === 'alpha line\nbeta v3 line\ngamma line\n' });

  // 5. READ BACK — the edit is durable through the stale-version guards.
  const read2 = valueOf('read', await call('read', { file_path: NOTES_MD }));
  expectEq('read-back line 2', read2.lines[1], { number: 2, text: 'beta v3 line' });
  emit('read.back', { path: NOTES_MD, line2: read2.lines[1]?.text });

  await ladderFinal();
};

/** The final ladder rungs (split at the size gate). */
const ladderFinal = async () => {
  // 6. STR_REPLACE — the str_replace_editor `str_replace` literal edit.
  const replaced = valueOf('str_replace', await call('str_replace_editor', {
    command: 'str_replace',
    path: NOTES_MD,
    old_str: 'gamma line',
    new_str: 'gamma final line',
  }));
  expectEq('str_replace result', replaced, `The file ${NOTES_MD} has been edited successfully.`);
  emit('str_replace', { path: NOTES_MD, oldStr: 'gamma line', newStr: 'gamma final line', result: replaced });

  // 7. LIST — str_replace_editor `view` on a DIRECTORY walks ctx.fs.listDir
  //    (the fs-local directory listing) into a typed two-level listing.
  const view = valueOf('view', await call('str_replace_editor', {
    command: 'view',
    path: NOTES,
  }));
  const viewRows = view.split('\n').filter((row) => row.startsWith('d\t') || row.startsWith('f\t'));
  expectEq('view has the directory row', viewRows.includes(`d\t${NOTES}`), true);
  expectEq('view has the file row', viewRows.includes(`f\t${NOTES_MD}`), true);
  emit('view', { path: NOTES, rows: viewRows });

  // 8. FAIL LOUD — a write OUTSIDE the pinned workspace refuses (the row
  //    cannot escape its world; the refusal names the seam).
  const outside = await call('write', {
    file_path: '/outside-the-workspace/evil.md',
    content: 'should not land',
  });
  expectEq('outside-write isError', outside.isError, true);
  const outsideText = outside.content?.[0]?.text ?? '';
  expectEq('outside-write names the boundary', outsideText.includes('outside the writable workspace root'), true);
  emit('guard.outside', {
    path: '/outside-the-workspace/evil.md',
    refused: outside.isError,
    error: outsideText.slice(0, 200),
  });

  // 9. FINAL CONTENT — one read proving the exact on-disk (in-VFS) state.
  const final = valueOf('read', await call('read', { file_path: NOTES_MD }));
  const finalText = final.lines.map((line) => line.text).join('\n');
  expectEq('final content', finalText, 'alpha line\nbeta v3 line\ngamma final line');
  emit('final', { path: NOTES_MD, totalLines: final.totalLines, content: finalText });

  emit('scenario.complete', { steps: 9, tools: ['read', 'write', 'edit', 'str_replace_editor'] });
  globalThis.__dshComplete(true);
};


