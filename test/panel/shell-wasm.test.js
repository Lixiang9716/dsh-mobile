import { describe, it, expect, beforeEach } from 'vitest';
import { apply, shellExecutor, manifest } from '../../system-plugins/dsh-shell-wasm/index.js';
import { WC_BYTES, GREP_BYTES, PINS } from '../../system-plugins/dsh-shell-wasm/programs.js';
import { workspace, sha256Hex, wasmRun } from './gateway-shim.js';

/** The pinned profile container the executor maps the workspace through
 * (boot.js's pinProfileContainer globals): the workspace sits INSIDE the
 * scope root, so a workspace-relative program is `spike/<name>.wasm`. */
const seedGlobals = () => {
  globalThis.__dshProfileCwd = '/profiles/default/spike';
  globalThis.__dshProfileScopeRoot = '/profiles/default';
};

/** One activation through the plugin's own apply: the starter writes are
 * async and the plugin fires them without awaiting, so the flush here is
 * what makes them observable. Returns the registered tools. */
const activate = async () => {
  const registered = [];
  apply({ tools: { register: (tool) => registered.push(tool) } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return registered;
};

beforeEach(() => {
  workspace.clear();
  seedGlobals();
});

describe('shell-wasm: the byte pins', () => {
  it('the committed program bytes match their generated sha256 pins', () => {
    expect(sha256Hex(WC_BYTES)).toBe(PINS.wc);
    expect(sha256Hex(GREP_BYTES)).toBe(PINS.grep);
  });
});

describe('shell-wasm: echo and wc execute and their output comes back', () => {
  it('echo reports its argument text with exit 0', async () => {
    await activate();
    const result = await shellExecutor.run({ command: 'echo hello from wasm' });
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'hello from wasm',
      stderr: '',
      command: 'echo hello from wasm',
    });
  });

  it('wc counts the lines, words and bytes of the command text', async () => {
    await activate();
    // the executor trims the command line (parseCommand), so the trailing
    // newline is gone — the POSIX tail rule keeps it three lines
    const result = await shellExecutor.run({ command: 'wc one\ntwo\nthree\n' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('3 3 13\n');
  });

  it('the executor result is exactly what the module produced over the dsh_wasm.c ABI', async () => {
    // the same input through the plugin executor AND raw through the ABI
    // shim: the shell adds nothing between the model and the module (the
    // executor's one transform is parseCommand's trim, mirrored here)
    await activate();
    workspace.set('app/spike/probe.wc', WC_BYTES);
    const throughShell = await shellExecutor.run({ command: 'wc a b c\nd e\n' });
    const direct = await wasmRun('app', 'spike/probe.wc', 'run', 'a b c\nd e');
    expect(throughShell.stdout).toBe(direct.output);
    expect(throughShell.exitCode).toBe(direct.result);
    expect(direct.output).toBe('2 5 9\n');
  });
});

describe('shell-wasm: grep is a real fixed-string filter', () => {
  it('grep emits the matching lines and exits 0, the grep convention', async () => {
    await activate();
    const result = await shellExecutor.run({
      command: 'grep err one\nerr two\nok three\n',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('err two\n');
  });

  it('grep exits 1 — a result, not a failure — when nothing matches', async () => {
    await activate();
    const result = await shellExecutor.run({
      command: 'grep zzz one\ntwo\nthree\n',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });
});

describe('shell-wasm: the honest surface', () => {
  it('an unknown program is 127 not-found, naming what DOES exist and where files belong', async () => {
    await activate();
    const result = await shellExecutor.run({ command: 'ls -la' });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('ls: not found');
    expect(result.stderr).toContain('Available programs: echo, wc, grep');
    expect(result.stderr).toContain('fs tools');
  });

  it('pipelines and redirection stay refused by name', async () => {
    await activate();
    const result = await shellExecutor.run({ command: 'echo hi | wc' });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('not implemented');
  });

  it('an empty command line is a silent success, the no-op shell convention', async () => {
    await activate();
    const result = await shellExecutor.run({ command: '   ' });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '', command: '   ' });
  });
});

describe('shell-wasm: the starter set', () => {
  it('activation writes echo, wc and grep into the workspace once each', async () => {
    await activate();
    expect([...workspace.keys()].sort()).toEqual([
      'app/spike/echo.wasm', 'app/spike/grep.wasm', 'app/spike/wc.wasm']);
    expect(workspace.get('app/spike/wc.wasm')).toEqual(WC_BYTES);
    expect(workspace.get('app/spike/grep.wasm')).toEqual(GREP_BYTES);
  });

  it("a starter already present is never overwritten (the user's copy wins)", async () => {
    await activate();
    const tampered = Uint8Array.from(WC_BYTES);
    tampered[0] = ~tampered[0];
    workspace.set('app/spike/wc.wasm', tampered);
    await activate();
    expect(workspace.get('app/spike/wc.wasm')).toBe(tampered);
  });

  it('the tool registration carries the honest description and works end to end', async () => {
    const [shell] = await activate();
    expect(shell.name).toBe('shell');
    expect(shell.description).toContain('wc');
    expect(shell.description).toContain('grep');
    expect(shell.description).toContain('NO file access');
    const value = await shell.execute({ command: 'echo hi there' });
    expect(value).toEqual({ exitCode: 0, stdout: 'hi there', stderr: '' });
  });

  it('the plugin manifest stays a service requiring the wasmRun capability', () => {
    expect(manifest.id).toBe('dsh-shell-wasm');
    expect(manifest.type).toBe('service');
    expect(manifest.capabilities.required).toContain('wasmRun');
  });
});
