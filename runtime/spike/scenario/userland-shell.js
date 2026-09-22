/**
 * Local E2E scenario `userland.shell` — the in-process Linux userland, driven from
 * the JS layer through the SAME objects the shipped app uses:
 *
 *   scenario → system-plugins/dsh-shell-ish (its exported shell executor)
 *            → gateway.js `ishRun` (contract v1.3.0)
 *            → the host's dispatch backend
 *            → dsh_ish.c → the emulated Alpine userland
 *
 * It runs on the desktop CLI (`runtime/spike/build/dsh-spike-cli … scenario/
 * userland-shell.js`) and its records are the ones `tools/e2e/scenarios/
 * userland-shell-local.json` matches one-to-one, so "the logs match" is checked the
 * same way every other evidence dir in this repository checks it.
 *
 * The command chain is deliberately not all `echo`: a real guest has to show
 * that it is a real one — an aarch64 ELF userland with its own release file, a
 * pipeline that behaves like a pipeline, a separate stderr stream, an exit
 * status, a file that survives into the workspace where the JS layer reads it
 * back, and a hung command that is killed without taking the guest with it.
 */
import { createLogger } from '../logger.js';
import { fsRead, fsScope } from '../gateway.js';
import { sha256Hex } from '../sha256.js';
import * as ShellIsh from 'system-plugins/dsh-shell-ish/index.js';

const SCENARIO = 'userland.shell';
const log = createLogger('ish.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const DELIVERABLE = 'ish-deliverable.txt';

/** The host's own answer for the scope root, pinned the way boot.js pins it
 * (this scenario drives the primitive directly, so nothing else pins them). */
const pinContainer = async () => {
  log.debug('pin scope container');
  const root = await fsScope.resolve();
  globalThis.__dshProfileScopeRoot = root.path;
  globalThis.__dshProfileCwd = root.path;
  return root.path;
};

/** One command line through the plugin's executor. */
const run = async (command, timeoutMs) => {
  log.debug('ish command', { command, timeoutMs: timeoutMs ?? 0 });
  return await ShellIsh.shellExecutor.run({ command, timeoutMs });
};

const step = async (event, command, extra = {}) => {
  const result = await run(command);
  log.debug('step done', { event, command, exitCode: result.exitCode });
  // stderr rides every step record: the guest's streams are SEPARATE, and a
  // record that carries only stdout cannot show that (the manifest's
  // guest.stderr rule asks for exactly the evidence this carries).
  emit(event, {
    command, exitCode: result.exitCode,
    stdout: result.stdout, stderr: result.stderr, ...extra,
  });
  return result;
};

const deliverable = async () => {
  const wrote = await run(`printf 'deliverable from the emulated guest\\n' > ${DELIVERABLE}`);
  emit('guest.wrote', { command: `printf … > ${DELIVERABLE}`, exitCode: wrote.exitCode });
  const read = await fsRead('app', `${await workdirName()}${DELIVERABLE}`);
  const bytes = read.bytes;
  const text = String.fromCharCode(...bytes);
  log.debug('deliverable read back', { bytes: bytes.length });
  emit('deliverable', {
    file: DELIVERABLE,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    text: text.trim(),
  });
};

const workdirName = async () => {
  const root = globalThis.__dshProfileScopeRoot ?? '';
  const cwd = globalThis.__dshProfileCwd ?? '';
  const prefix = cwd.slice(root.length).replace(/^\/+/, '');
  log.debug('workdir prefix', { prefix });
  return prefix.length > 0 ? `${prefix}/` : '';
};

const main = async () => {
  log.debug('scenario start', { name: SCENARIO });
  await pinContainer();
  emit('plugin', { name: ShellIsh.name, tool: 'ish' });

  await step('guest.machine', 'uname -m');
  await step('guest.release', 'cat /etc/alpine-release');
  await step('guest.user', 'id -un');
  await deliverable();
  await step('guest.stderr', 'echo expected-on-stderr >&2; exit 7');
  await step('guest.pipeline', "printf 'b\\na\\nc\\n' | sort | tr '\\n' '-'");

  const hung = await run('sleep 30; echo never', 1500);
  emit('guest.timeout', { command: 'sleep 30; echo never', timedOut: hung.timedOut });
  // The kill must take the command, not the guest: the next command has to work.
  await step('guest.recovered', 'echo still-alive');

  emit('scenario.complete', { commands: 9 });
  globalThis.__dshComplete(true);
};

main().catch((error) => {
  log.debug('scenario threw', { reason: `${error?.message ?? error}` });
  emit('scenario.failed', { reason: `${error?.message ?? error}` });
  globalThis.__dshComplete(false, `${error?.message ?? error}`);
});
