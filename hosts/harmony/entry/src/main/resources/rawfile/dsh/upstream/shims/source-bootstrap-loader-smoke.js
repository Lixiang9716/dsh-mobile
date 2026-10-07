// dsh:logging-exempt (shim layer: no transport, no I/O of its own)
/**
 * source-bootstrap-loader-smoke.js — the @deepseek-ai/dsh-loader-smoke
 * overlay for SOURCE-ENTRY bootstraps (W8). Registered over the vendored
 * lib by runtime-modules (the __dshModuleDefine seam is checked before the
 * bare map, the same shadow channel as the cordis failure-face overlay).
 *
 * Why an overlay: the vendored lib's resolveExampleLaunch calls
 * `import.meta.resolve('tsx')` — the C resolve throws for the slash-less
 * bare name (unmapped), which failed every src-mode launch in the corpus
 * (0/6 loader-smoke, the process-exit host scenarios, the session-snapshot
 * agent launches). runLoaderSmoke reaches that resolve through a
 * module-INTERNAL call, so patching the exported face alone cannot serve
 * the smoke harness; the overlay re-exports the vendored lib verbatim and
 * re-implements EXACTLY the two faces whose bodies name a tsx specifier —
 * same code, same message formats, with the tsx resolution pointed at the
 * source-bootstrap face (source-bootstrap-tsx.js) and one staging pass
 * that puts the seeded child entries on the real disk the argv remap
 * re-roots to (D6: the staged bytes are the vendored/seeded bytes, verbatim).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { clearedProxyEnv } from '@deepseek-ai/dsh-http-proxy';
import * as vendored from 'vendor/npm/@deepseek-ai/dsh-loader-smoke@0.1.6-alpha.2/lib/index.js';
import {
  resolveTsxChildFace,
  materializeChildArgv,
} from 'upstream/shims/source-bootstrap-tsx.js';

/** Verbatim vendored faces that never touch a tsx specifier. */
export const EXAMPLE_MODE_ENV = vendored.EXAMPLE_MODE_ENV;
export const LOADER_SMOKE_TEST_TIMEOUT_MS = vendored.LOADER_SMOKE_TEST_TIMEOUT_MS;
export const resolveExampleMode = vendored.resolveExampleMode;
export const runFixtureTurn = vendored.runFixtureTurn;

/** Vendored logic verbatim (lib/index.js resolveExampleLaunch) with the
 * import.meta.resolve('tsx'|'tsx/esm') call replaced by the source-
 * bootstrap face path. The lib branch, the mode validation, and the env
 * assembly are byte-for-byte the vendored shapes the specs pin. */
export const resolveExampleLaunch = (options) => {
  const mode = options.mode ?? resolveExampleMode();
  const configArgs = options.configArgs ?? [];
  const env = {
    ...clearedProxyEnv(),
    ...options.env,
  };
  if (mode === 'src') {
    if (options.tsconfigPath === undefined) {
      throw new Error("resolveExampleLaunch: 'src' mode needs tsconfigPath for the workspace paths map.");
    }
    const kind = options.sourceImport === 'tsx/esm' ? 'tsx/esm' : 'tsx';
    const tsxLoader = resolveTsxChildFace(kind);
    if (typeof tsxLoader !== 'string') {
      throw new Error(`resolveExampleLaunch: no tsx face could be staged for '${kind}' (no real install and no fallback)`);
    }
    // The env is the vendored VERBATIM passthrough — the shape tests pin
    // TSX_TSCONFIG_PATH === the caller's tsconfigPath. The missing-file
    // correction happens at the SPAWN seam instead (see
    // installSpawnArgvStager): real tsx throws at register time when the
    // env names a missing file, and only actual children read it.
    env.TSX_TSCONFIG_PATH = options.tsconfigPath;
    return {
      command: process.execPath,
      args: ['--import', tsxLoader, options.srcBin, ...configArgs],
      env,
    };
  }
  return {
    command: process.execPath,
    args: [options.libBin ?? toLibBin(options.srcBin), ...configArgs],
    env,
  };
};

/** Vendored toLibBin verbatim (lib/index.js): derive <pkg>/lib/<name>.js
 * from a source bin. Module-local because the vendored export list does
 * not carry it. */
const toLibBin = (srcBin) => {
  const markerLength = 5;
  const cut = Math.max(srcBin.lastIndexOf('/src/'), srcBin.lastIndexOf('\\src\\'));
  if (cut === -1) throw new Error(`resolveExampleLaunch: expected a "/src/" segment or Windows equivalent in bin path ${JSON.stringify(srcBin)}.`);
  const separator = srcBin.slice(cut, cut + 1);
  const tail = srcBin.slice(cut + markerLength).replace(/\.ts$/, '.js');
  return `${srcBin.slice(0, cut)}${separator}lib${separator}${tail}`;
};

/** Vendored runLoaderSmoke verbatim (lib/index.js) with two deltas: our
 * resolveExampleLaunch (above) and one materializeChildArgv pass over the
 * launch args — the seeded child entries must exist under the bundle root
 * before the REAL child (and the C argv remap that re-roots '/x') runs. */
export const runLoaderSmoke = async (options) => {
  const providedCwd = options.cwd !== undefined;
  const cwd = providedCwd ? options.cwd : await mkdtemp(join(options.tempDirParent ?? tmpdir(), options.tempDirPrefix));
  const DEFAULT_PROCESS_TIMEOUT_MS = 30000;
  const processTimeoutMs = options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  try {
    await options.prepare?.(cwd);
    const launch = resolveExampleLaunch({
      srcBin: options.binScript,
      libBin: options.libBinScript,
      configArgs: options.binArgs ?? [options.configPath],
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      tsconfigPath: options.tsconfigPath,
      env: {
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        ...options.env,
      },
    });
    materializeChildArgv(launch.args);
    const result = await execa(launch.command, launch.args, {
      cwd,
      env: launch.env,
      input: '',
      timeout: processTimeoutMs,
      killSignal: 'SIGKILL',
      reject: false,
      stripFinalNewline: false,
    });
    if (result.timedOut) throw new Error(`${options.label} did not exit within ${processTimeoutMs / 1e3}s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const expectedExitCode = options.expectedExitCode ?? 0;
    if (result.exitCode !== expectedExitCode) throw new Error(`${options.label} exited ${String(result.exitCode)} (expected ${expectedExitCode}). stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    await options.inspect?.(cwd);
    return { stdout: result.stdout, stderr: result.stderr };
  } finally {
    if (!providedCwd) await rm(cwd, { recursive: true, force: true });
  }
};
