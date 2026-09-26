// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/tool-present.js — the CREATION-MODE delivery tool (the mobile
 * port of upstream @deepseek-ai/dsh-tool-present at the pin). The model
 * calls `present` to declare existing workspace files as deliverables for
 * the user; on the tool result the session journals
 * `deliverables/presented {turn, callId, files}` — the event the web
 * clients render as creation cards (tap → the file's contents open on the
 * screen). Upstream semantics mirrored: the files must ALREADY exist (the
 * model writes them first — editor/shell), relative paths resolve against
 * the session cwd, 1..maxFiles per call, and the event lands only on a
 * successful (non-error) tool result.
 *
 * Mounted only under the creation flag (boot options.creation → the
 * interactive/user-facing seat), so every existing spine leg boots
 * byte-identically. Registration goes through the vendored defineTool, whose
 * schema compiler takes a flat property map for `parameters` and a value
 * schema for `output.schema` — requiredness is property-level `required:
 * true` everywhere (the DSL has no array form), and every nested object
 * declares `additionalProperties` explicitly (upstream's run_code is the
 * reference shape).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Stable identity (upstream tool-present's). */
export const name = 'tool-present';

/** Services used by the delivery tool (cordis resolves them onto ctx). */
export const inject = ['tools', 'fs', 'sessionProjections'];

/** Validated per-call delivery limit. */
const DEFAULT_MAX_FILES = 8;

/** One presented-file item schema (shared by the parameter and the
 * output). */
const presentedFileItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    description: { type: 'string' },
  },
};

/** One string file-field property; `required` only on the must-have fields. */
const fileProp = (description, required) => ({
  type: 'string', ...(required === true ? { required: true } : {}), description,
});

/** The `files` parameter: an array of {path, description?}. */
const filesParameter = {
  type: 'array', required: true,
  items: presentedFileItem,
};

/** The tool result schema + renderer (the output goes through the VALUE
 * schema compiler: required is an ARRAY there; the parameters root uses the
 * property-map compiler where required is per-property). */
const presentOutput = {
  schema: {
    // The output VALUE schema DSL accepts no `required` anywhere — the
    // result's shape is declared, its requiredness is not.
    type: 'object',
    additionalProperties: false,
    properties: {
      turn: { type: 'integer' },
      files: {
        type: 'array',
        items: presentedFileItem,
      },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: (value?.files ?? []).map((file) => `Presented ${file.path}`).join('\n'),
  }],
};

const validateFiles = async (ctx, files, exec, cwd) => {
  for (const file of files) {
    if (typeof file?.path !== 'string' || file.path.trim().length === 0) {
      throw new Error('present requires a non-empty file path');
    }
    const entry = await ctx.fs.lstat(file.path, { cwd }, exec.signal);
    if (entry !== undefined && entry.type !== 'file') {
      throw new Error(`Cannot present ${file.path}: not a regular file`);
    }
    const target = await ctx.fs.resolve(file.path, { cwd, signal: exec.signal });
    const info = await ctx.fs.stat(target, exec.signal);
    if (info === undefined) {
      throw new Error(`Cannot present ${file.path}: file not found. `
        + 'Check the path, create the file if needed, and retry.');
    }
    if (info.type !== 'file') {
      throw new Error(`Cannot present ${file.path}: not a regular file`);
    }
  }
};

const makeExecute = (ctx, maxFiles, pending) => async (args, exec) => {
  if (exec.agent === undefined) throw new Error('present requires an agent Session');
  const session = exec.agent.session;
  const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary');
  if (boundary === undefined || boundary.openTurnStartSeq === null) {
    throw new Error('present requires an open turn');
  }
  const files = Array.isArray(args?.files) ? args.files : [];
  if (files.length === 0 || files.length > maxFiles) {
    throw new Error(`present accepts 1 to ${maxFiles} files`);
  }
  const cwd = session.header.cwd;
  if (cwd === undefined) throw new Error('present requires a workspace');
  await validateFiles(ctx, files, exec, cwd);
  exec.signal.throwIfAborted();
  pending.set(exec, { session, turn: boundary.lastTurn, files });
  return {
    turn: boundary.lastTurn,
    files: files.map((file) => ({ path: file.path,
      ...(file.description === undefined ? {} : { description: file.description }) })),
  };
};

export function apply(ctx, config) {
  const maxFiles = config?.maxFiles ?? DEFAULT_MAX_FILES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error('present requires a positive integer maxFiles');
  }
  const pending = new Map(); // exec → { session, turn, files }
  ctx.tools.register(defineTool({
    name: 'present',
    description: 'Declare existing files accessible through the Session filesystem as final deliverables. '
      + 'When a file you create or update is an output the user asked to receive, you must call present after writing it and before your final response, including files created through Bash or code execution. '
      + 'Mentioning its path in your reply does not replace this call. The files must already exist. '
      + 'The user opens the current source files; their contents are not copied or preserved.',
    parameters: {
      files: filesParameter,
    },
    output: presentOutput,
    execute: makeExecute(ctx, maxFiles, pending),
  }));

  ctx.on('tools/result', (exec, result) => {
    const delivery = pending.get(exec);
    pending.delete(exec);
    if (delivery === undefined || result.isError) return;
    delivery.session.append('deliverables/presented', {
      turn: delivery.turn, callId: exec.callId, files: delivery.files,
    });
  });
}
