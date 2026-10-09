/**
 * dsh-shell-ish — the shell executor for hosts that cannot spawn a shell but can
 * run a Linux userland in-process.
 *
 * `dsh-shell-wasm` (beside this file) answers the same question for hosts whose
 * only in-process engine is a WebAssembly interpreter: its "PATH" is the
 * workspace and a program is a `.wasm` module. That executor is honest but thin
 * — one module per command, no pipelines, no quoting, no `ls`, no `cat`.
 *
 * This one is the other half of the answer for iOS: the host runs a real Linux
 * userland (an aarch64 Alpine rootfs) inside its own process — emulated
 * instruction by instruction by the vendored iSH engine, no child process, no
 * second OS — and exposes it as the contract's v1.3.0 `ishRun` primitive. So the
 * command line is interpreted by a REAL `/bin/sh` (busybox in the starter
 * rootfs), a program is a real ELF from that userland, and pipelines,
 * redirection, quoting, globbing, `cd`, environment and exit statuses are the
 * guest's own semantics rather than an approximation invented here.
 *
 * What this file adds on top is only the two things the primitive leaves to its
 * caller:
 *
 *   - the working directory: the authorized workspace is mounted inside the guest
 *     and every command starts there, so a relative path the model writes lands
 *     in the workspace the rest of the session sees;
 *   - the tool surface: one `ish` tool, named for the host platform's own shell
 *     (this is the iOS host's shell), whose result carries stdout, stderr, the
 *     exit status and the two honesty flags (`timedOut`, `truncated`).
 *
 * Deliberately NOT done here, and said out loud rather than faked: no session
 * persistence beyond what the guest itself keeps (each command is a fresh
 * process, so `cd` lasts for one command line — chain with `&&` or use absolute
 * paths), no pty (there is no terminal in this host), and no network
 * configuration of our own (the rootfs's resolver, if any, is what the guest
 * has).
 */
import { createLogger } from 'logger.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ishRun, GatewayError } from 'gateway.js';

const log = createLogger('dsh.shell.ish');

export const manifest = {
  schemaVersion: 1,
  id: 'dsh-shell-ish',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['ishRun', 'fsRead'], optional: [] },
  hooks: { activate: 'activate' },
};

/** The workspace-relative directory a command starts in, as the gateway's
 * (scope, path) pair. Both roots are globals the spine pins (boot.js), so the
 * mapping is read, never guessed — and a host that granted no scoped workspace
 * gets a refusal naming the missing grant instead of a command that runs
 * somewhere unexpected. */
const workdirFor = (relative) => {
  const workspace = globalThis.__dshProfileCwd;
  const scopeRoot = globalThis.__dshProfileScopeRoot;
  if (typeof workspace !== 'string' || typeof scopeRoot !== 'string'
      || !workspace.startsWith(scopeRoot)) {
    throw new GatewayError('unavailable', 'ish',
      'the host granted no scoped workspace (no __dshProfileScopeRoot)');
  }
  const prefix = workspace.slice(scopeRoot.length).replace(/^\/+/, '');
  const clean = String(relative ?? '').replace(/^\/+|\/+$/g, '');
  const guestDir = prefix.length > 0 ? (clean.length > 0 ? `${prefix}/${clean}` : prefix) : clean;
  log.debug('workspace mapped into the guest', { guestDir });
  return guestDir;
};

/** Run one command line in the guest. Returns the shape the shell layer reads:
 * `{ exitCode, stdout, stderr, timedOut }`. A non-zero exit is a RESULT, not a
 * failure — the model asked what the command did, and the status is the answer.
 * Only a host that cannot run the command at all rejects, and that rejection
 * keeps the gateway's own code. */
const runCommand = async (command, options) => {
  const spec = {
    command,
    workdir: options?.workdir,
    timeoutMs: options?.timeoutMs,
  };
  log.debug('ish run', { command: spec.command, workdir: spec.workdir ?? '' });
  let result;
  try {
    result = await ishRun('app', workdirFor(spec.workdir),
      ['/bin/sh', '-c', String(command)],
      spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : undefined);
  } catch (error) {
    // The gateway's audit record keeps the OUTCOME (`invalid`, `io`, …) and the
    // tool layer hands the model a message — neither names the FIELD that failed
    // validation, which is the whole diagnosis when a call is rejected before
    // the guest ever starts. Log the reason where an operator can read it.
    let guestDir = '(unmapped)';
    try { guestDir = workdirFor(spec.workdir); } catch { /* the mapping is the failure */ }
    log.warn('ish call rejected', {
      code: `${error?.code ?? 'unknown'}`,
      message: `${error?.message ?? error}`,
      guestDir,
      timeoutMs: spec.timeoutMs ?? 0,
      argvHead: `/bin/sh -c ${String(command).slice(0, 60)}`,
    });
    throw error;
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut === true,
    truncated: result.truncated === true,
    command,
  };
};

/** The `shell` capability, as the upstream tool layer consumes it: `resolve`
 * normalizes a request, `run` executes one foreground command. This is the
 * object the ported `dsh-shell` subclass wraps — the same seam
 * `dsh-shell-wasm` exposes, with a different backend. */
export function activate({ register, host }) {
  log.debug('dsh-shell-ish activating', { host: host ?? 'unknown' });
  register('shell', shellExecutor);
}

export const name = 'dsh-shell-ish';
export const inject = ['tools'];

/** The executor, as an object: the shape `ctx.shell` has upstream
 * (`resolve` + a foreground `run`), minus the Service base class this package
 * does not vendor yet. */
export const shellExecutor = {
  resolve(request) {
    log.debug('shell resolve', { command: request.command });
    return {
      command: request.command,
      workdir: request.workdir,
      timeoutMs: request.timeoutMs,
      stdoutMaxBytes: request.stdoutMaxBytes,
    };
  },
  async run(request) {
    const spec = this.resolve(request);
    log.debug('shell run', { command: spec.command, timeoutMs: spec.timeoutMs ?? 0 });
    return await runCommand(spec.command, spec);
  },
  // No sandbox mode: the guest is not a separate process to confine, and it
  // reaches the host only through the gateway primitive, which is already
  // scope-confined and audited.
  sandboxMode: undefined,
};

const ISH_DESCRIPTION = 'Run one command line in a real Linux (Alpine aarch64) '
  + 'userland that this host emulates INSIDE the app process — a shell binary '
  + 'and a child process are both impossible on this platform, but the guest '
  + 'userland is real: /bin/sh is busybox, the command is parsed by that shell, '
  + 'and pipelines, redirection, quoting, globbing and `cd` behave the way they '
  + 'do in Linux. You start in your workspace (mounted in the guest), so '
  + 'relative paths you write land where the rest of the session can see them. '
  + 'Each call is a fresh guest process: `cd` lasts for one command line, so '
  + 'chain with `&&`. The command set is what the rootfs ships (busybox '
  + 'applets); installing packages is possible in principle but the host stages '
  + 'no network configuration for the guest. A non-zero exit status is a normal '
  + 'result, not an error.';

/** The guest root this host staged, from whichever convention it used to say so:
 * a pinned global, the profile launch env the spine pins (boot.js:
 * `__dshProfileLaunch`), or the C host's `__dshLaunchEnv()` (the desktop CLI
 * passes DSH_ISH_ROOTFS that way). Empty = no userland on this host. */
const stagedGuestRoot = () => {
  const pick = (value) => (typeof value === 'string' && value.length > 0 ? value : '');
  let resolved = pick(globalThis.__dshIshRootfs);
  if (resolved === '') resolved = pick(globalThis.__dshProfileLaunch?.DSH_ISH_ROOTFS);
  if (resolved === '') {
    try {
      resolved = pick(JSON.parse(globalThis.__dshLaunchEnv?.() ?? '{}').DSH_ISH_ROOTFS);
    } catch {
      resolved = '';
    }
  }
  // Logged once per activation, not per command: this is the decision the tool
  // offer rests on, and an operator reading the log should see which host
  // declaration (if any) it came from.
  log.debug('guest root from the host declaration', { rootfs: resolved, offered: resolved !== '' });
  return resolved;
};

export const apply = (ctx) => {
  const guest = stagedGuestRoot();
  if (typeof guest !== 'string' || guest.length === 0) {
    // No guest root was staged in this app container, so there is no Linux to
    // run: the honest thing is not to offer the model a tool that cannot work.
    log.info('no Linux guest staged by this host; the ish tool is not offered');
    return;
  }
  log.debug('registering the ish tool', { rootfs: guest });
  ctx.tools.register(defineTool({
    name: 'ish',
    description: ISH_DESCRIPTION,
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The command line, e.g. "ls -la && cat README.md" — it is '
          + 'interpreted by the guest\'s own /bin/sh.',
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
          timedOut: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.stdout}${value.stderr}`
          + `\n[exit code: ${value.exitCode}${value.timedOut ? ' · timed out, killed' : ''}]`,
      }],
    },
    async execute(args) {
      const result = await runCommand(args.command);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    },
  }));
};
