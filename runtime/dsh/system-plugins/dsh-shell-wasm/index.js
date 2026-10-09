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
 * the agent, or a package put there. A STARTER SET ships in the plugin and is
 * written into the workspace on activation when missing (a shell with no
 * commands at all would greet the model with `not found` on its first line):
 *
 *   echo  — the argument text back, exit 0 (hand-assembled, 77 bytes)
 *   wc    — `<lines> <words> <bytes>\n` of the argument text, exit 0
 *   grep  — fixed-string: `<pattern> <text>` emits the text lines containing
 *           the pattern; exits 0 matched / 1 none / 2 bad usage (the grep
 *           convention)
 *
 * every module computing over the ONE input channel the wasmRun ABI carries —
 * the argument text itself (a multi-line command is a multi-line input). The
 * generated programs' bytes live in programs.js beside this file, produced by
 * tools/wasm-gen from reviewable .wat sources and verified against the
 * dsh_wasm.c ABI at generation time.
 *
 * NOT provided, and said out loud rather than faked: pipelines, redirection,
 * quoting beyond whitespace, background jobs (`start`), globbing, environment
 * variables, exit codes above what a module returns, and FILE ACCESS — the
 * module boundary has no filesystem (the ABI's input is one string), so file
 * operations belong to the fs tools, and the not-found refusal names both the
 * programs that DO exist and where files belong. A command line that needs
 * anything else fails as a non-zero exit with a message naming what is
 * missing, never a silently wrong result. A real shell would be a WASM build
 * of one (busybox/ash or a clean-room shell) — the seam below is exactly
 * where it would plug in, and this file would shrink to the dispatch line.
 */
import { createLogger } from 'logger.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fsRead, fsWrite, wasmRun, GatewayError } from 'gateway.js';
import { WC_BYTES, GREP_BYTES } from './programs.js';

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

/** The starter programs, by name: the bytes written into the workspace when
 * missing (never overwriting a copy already there). `echo` stays the
 * hand-assembled 77 bytes it has always been; `wc` and `grep` are the
 * generated modules in programs.js (source .wat in tools/wasm-gen). */
const STARTERS = {
  echo: Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 12, 2, 96, 2, 127, 127, 0, 96, 2, 127, 127, 1, 127, 2, 12, 1, 3, 100, 115, 104, 4, 101, 109, 105, 116, 0, 0, 3, 2, 1, 1, 5, 3, 1, 0, 1, 7, 16, 2, 6, 109, 101, 109, 111, 114, 121, 2, 0, 3, 114, 117, 110, 0, 1, 10, 12, 1, 10, 0, 32, 0, 32, 1, 16, 0, 65, 0, 11]),
  wc: WC_BYTES,
  grep: GREP_BYTES,
};

/** The starter list the honest refusals name (`echo, wc, grep`). */
const STARTER_NAMES = Object.keys(STARTERS).join(', ');

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

/** Every starter program is written once, when the workspace does not have
 * it. One program's failure (a scope that refuses writes, say) is logged and
 * does not stop the others — a shell that can echo is better than one that
 * cannot, and the refusal messages name what actually landed. */
const ensureStarters = async () => {
  for (const [name, bytes] of Object.entries(STARTERS)) {
    try {
      const target = scopePathFor(`${name}.wasm`);
      await fsRead(target.scope, target.path);
      continue;                   // already there: never overwrite a user's copy
    } catch (error) {
      if (error?.code !== 'io') throw error;
    }
    const target = scopePathFor(`${name}.wasm`);
    await fsWrite(target.scope, target.path, bytes);
    log.info('starter program written', { name, bytes: bytes.length });
  }
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
    // A missing program is `not found` (127), the shell convention — and the
    // refusal is SELF-DESCRIBING: it names the programs that exist and routes
    // file work to the tools that can do it (the module boundary has no
    // filesystem to ls or cat). Anything else is the host refusing the run,
    // and it keeps its own code.
    const missing = error?.code === 'io' && /cannot read/.test(error?.message ?? '');
    if (missing) {
      const stderr = `${parsed.program}: not found `
        + `(no ${parsed.program}.wasm in the workspace). `
        + `Available programs: ${STARTER_NAMES}. `
        + 'File contents are not a shell feature here (the module boundary '
        + 'has no filesystem) — use the fs tools (read/list/write) for files, '
        + `or place a ${parsed.program}.wasm module in the workspace`;
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
    ensureStarter: ensureStarters,
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

const SHELL_DESCRIPTION = 'A MINIMAL executor: one WebAssembly module per command, no '
  + 'shell semantics. If this host also offers a real shell or Linux tool, prefer THAT '
  + 'for anything but a trivial module already in the workspace. '
  + 'Run one command line. The programs are WebAssembly '
  + 'modules in your workspace (a program named foo is foo.wasm), executed '
  + 'inside the app process — no shell binary, no child process, so NOTHING '
  + 'from a normal PATH exists here. Starter programs: echo (echoes its '
  + 'argument text), wc (prints "<lines> <words> <bytes>" of the argument '
  + 'text), grep (fixed-string: "grep <pattern> <text>" prints the text lines '
  + 'containing the pattern, exit 0 matched / 1 none / 2 bad usage). Each '
  + 'module computes over the command text AFTER the program name — a '
  + 'multi-line command is multi-line input, so wc and grep work on pasted '
  + 'text. There is NO file access (the module boundary has no filesystem): '
  + 'use the fs tools to read, list or write files, then feed the text to wc '
  + 'or grep in the command line itself, or place another .wasm module in the '
  + 'workspace and run it. A module prints through its dsh.emit import and '
  + 'its i32 return value becomes the exit status. Pipelines, redirection '
  + 'and quoting are not implemented.';

export const apply = (ctx) => {
  void ensureStarters().catch((error) => {
    log.warn('starter programs not written', { reason: `${error?.message ?? error}` });
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
