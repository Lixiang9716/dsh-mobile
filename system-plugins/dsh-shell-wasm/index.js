// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * dsh-shell-wasm — the shell executor for hosts that have no shell.
 *
 * Upstream's shell layer is two pieces: the `ctx.shell` capability
 * (`@deepseek-ai/dsh-shell` — one executor per context) and an executor
 * implementation that spawns a real binary (`dsh-bash-local` builds a
 * `ctx.subprocess` spawn spec; `dsh-pwsh-local` is its win32 sibling). iOS has
 * neither a shell binary nor the ability to spawn one, so this is the third
 * executor in that family: a sibling of bash-local/pwsh-local whose backend is
 * WebAssembly, interpreted **in-process** by the host (contract v1.2.0
 * `wasmRun`).
 *
 * The model's mental model is unchanged — it writes a command line, it gets
 * stdout and an exit status — but what runs is not a program from `/bin`:
 *
 *   `echo hello`  →  the module `echo.wasm` in the workspace, called with the
 *                    argument text, its `dsh.emit` output collected, its i32
 *                    return value taken as the exit status.
 *
 * So "the PATH" is the workspace, and a program is an ordinary file the user,
 * the agent, or a package put there. `echo` ships as a starter program, written
 * into the workspace on activation when it is missing (a shell with no commands
 * at all would greet the model with `not found` on its first line).
 *
 * NOT provided, and said out loud rather than faked: pipelines, redirection,
 * quoting beyond whitespace, background jobs (`start`), globbing, environment
 * variables, and exit codes above what a module returns. A command line that
 * needs any of those fails as a non-zero exit with a message naming what is
 * missing, never a silently wrong result. A real shell would be a WASM build of
 * one (busybox/ash or a clean-room shell) — the seam below is exactly where it
 * would plug in, and this file would shrink to the dispatch line.
 */
import { createLogger } from 'logger.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fsRead, fsWrite, wasmRun, GatewayError } from 'gateway.js';

const log = createLogger('dsh.shell.wasm');

export const manifest = {
  schemaVersion: 1,
  id: 'dsh-shell-wasm',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['wasmRun', 'fsRead', 'fsWrite'], optional: [] },
  hooks: { activate: 'activate' },
};

/** The starter program: `echo` — emits its argument text, exits 0.
 * Hand-assembled from echo.wat (77 bytes); it imports dsh.emit, exports its
 * memory, and `run(ptr, len)` reports the argument text back to the host. */
const STARTER_ECHO = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 12, 2, 96, 2, 127, 127, 0, 96, 2, 127, 127, 1, 127, 2, 12, 1, 3, 100, 115, 104, 4, 101, 109, 105, 116, 0, 0, 3, 2, 1, 1, 5, 3, 1, 0, 1, 7, 16, 2, 6, 109, 101, 109, 111, 114, 121, 2, 0, 3, 114, 117, 110, 0, 1, 10, 12, 1, 10, 0, 32, 0, 32, 1, 16, 0, 32, 1, 11]);

/** The workspace-relative path mapped onto the gateway's (scope, path) pair;
 * the same convention the wasm tool used — both roots are pinned globals the
 * spine sets (boot.js), so the mapping is read, never guessed. */
const scopePathFor = (relative) => {
  const workspace = globalThis.__dshProfileCwd;
  const scopeRoot = globalThis.__dshProfileScopeRoot;
  if (typeof workspace !== 'string' || typeof scopeRoot !== 'string'
      || !workspace.startsWith(scopeRoot)) {
    throw new GatewayError('unavailable', 'shell',
      'the host granted no scoped workspace (no __dshProfileScopeRoot)');
  }
  const prefix = workspace.slice(scopeRoot.length).replace(/^\/+/, '');
  const clean = String(relative).replace(/^\/+/, '');
  return { scope: 'app', path: prefix.length > 0 ? `${prefix}/${clean}` : clean };
};

/** One parsed command line: program + the argument text the module receives. */
/** One shell result: the shape the tool layer and the model both read. */
const shellResult = (result, command) => {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    command,
  };
};

const parseCommand = (command) => {
  const text = String(command ?? '').trim();
  if (text.length === 0) return null;
  const at = text.search(/\s/);
  if (at < 0) return { program: text, args: '' };
  return { program: text.slice(0, at), args: text.slice(at + 1).trim() };
};

/** The starter program is written once, when the workspace does not have it. */
const ensureStarter = async (name) => {
  try {
    const target = scopePathFor(`${name}.wasm`);
    await fsRead(target.scope, target.path);
    return;                       // already there: never overwrite a user's copy
  } catch (error) {
    if (error?.code !== 'io') throw error;
  }
  const target = scopePathFor(`${name}.wasm`);
  await fsWrite(target.scope, target.path, STARTER_ECHO);
  log.info('starter program written', { name, bytes: STARTER_ECHO.length });
};

/** Run one command line through the WASM program it names.
 * Returns `{ exitCode, stdout, stderr }` — the shape a shell result has. */
const runCommand = async (command) => {
  const parsed = parseCommand(command);
  if (parsed === null) return { exitCode: 0, stdout: '', stderr: '' };
  if (/[|><&;$`()]/.test(parsed.args) || /[|><&;$`()]/.test(parsed.program)) {
    return {
      exitCode: 2, stdout: '',
      stderr: 'dsh-shell-wasm: pipelines, redirection and quoting are not '
        + 'implemented by this executor (it runs one WASM program per command)',
    };
  }
  const target = scopePathFor(`${parsed.program}.wasm`);
  try {
    const run = await wasmRun(target.scope, target.path, 'run', parsed.args);
    return { exitCode: run.result, stdout: run.output, stderr: '' };
  } catch (error) {
    // A missing program is `not found` (127), the shell convention; anything
    // else is the host refusing the run, and it keeps its own code.
    const missing = error?.code === 'io' && /cannot read/.test(error?.message ?? '');
    if (missing) {
      const stderr = `${parsed.program}: not found `
        + `(no ${parsed.program}.wasm in the workspace)`;
      return { exitCode: 127, stdout: '', stderr };
    }
    return { exitCode: 126, stdout: '', stderr: `${parsed.program}: ${error?.message ?? error}` };
  }
};

/** The `shell` capability, as the upstream tool layer consumes it: `resolve`
 * normalizes a request, `run` executes one foreground command. `start`
 * (background processes) is deliberately absent — see the header. */
export function activate({ register }) {
  register('shell', {
    resolve(request) {
      return {
        command: request.command,
        workdir: request.workdir ?? globalThis.__dshProfileCwd ?? '',
        timeoutMs: request.timeoutMs,
        stdoutMaxBytes: request.stdoutMaxBytes,
      };
    },
    async run(request) {
      const spec = this.resolve(request);
      const result = await runCommand(spec.command);
      return shellResult(result, spec.command);
    },
    // No sandbox mode: there is no separate process to confine. The module
    // reaches the host only through the gateway primitives, which are already
    // scope-confined and audited.
    sandboxMode: undefined,
    ensureStarter,
  });
}

/** The spine's mount shape (boot.js): the same executor, plus the model-facing
 * `shell` tool. Kept in one file with `activate` because they are one
 * implementation seen from two sides — the registry installs it as a service,
 * the spine mounts it to give the model commands to run. When the upstream
 * shell tool is ported (it needs dsh-shell + dsh-shell-env + dsh-jobs), the
 * tool below is what gets deleted and `shellExecutor` is what the ported
 * `dsh-shell` subclass wraps. */
export const name = 'dsh-shell-wasm';
export const inject = ['tools'];

/** The executor, as an object: the shape `ctx.shell` has upstream
 * (`resolve` + a foreground `run`), minus the Service base class this package
 * does not vendor yet. */
export const shellExecutor = {
  resolve(request) {
    return {
      command: request.command,
      workdir: request.workdir ?? globalThis.__dshProfileCwd ?? '',
      timeoutMs: request.timeoutMs,
      stdoutMaxBytes: request.stdoutMaxBytes,
    };
  },
  async run(request) {
    const spec = this.resolve(request);
    const result = await runCommand(spec.command);
    return shellResult(result, spec.command);
  },
  sandboxMode: undefined,
};

const SHELL_DESCRIPTION = 'Run one command line. The programs are WebAssembly '
  + 'modules in your workspace (a program named foo is foo.wasm), executed '
  + 'inside the app process — no shell binary, no child process, so NOTHING '
  + 'from a normal PATH exists here (no ls, no cat, no sh). Write or place a '
  + 'module first, then run it. The module prints through its dsh.emit import '
  + 'and its i32 return value becomes the exit status. Pipelines, redirection '
  + 'and quoting are not implemented.';

export const apply = (ctx) => {
  void ensureStarter('echo').catch((error) => {
    log.warn('starter program not written', { reason: `${error?.message ?? error}` });
  });
  ctx.tools.register(defineTool({
    name: 'shell',
    description: SHELL_DESCRIPTION,
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The command line, e.g. "echo hello" — program name plus '
          + 'whitespace-separated arguments.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.stdout}${value.stderr}`
          + `\n[exit code: ${value.exitCode}]`,
      }],
    },
    async execute(args) {
      const result = await shellExecutor.run({ command: args.command });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
  }));
};
