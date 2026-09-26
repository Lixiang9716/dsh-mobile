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
 * byte-identically.
 */

/** Stable identity (upstream tool-present's). */
export const name = 'tool-present';

/** Services used by the delivery tool (cordis resolves them onto ctx). */
export const inject = ['tools', 'fs', 'sessionProjections'];

/** Validated per-call delivery limit. */
const DEFAULT_MAX_FILES = 8;

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

/** The tool result schema + renderer — reuses the flat files-schema piece
 * with the output-dialect object (required as an array). */
const fileProp = (description) => ({
  type: 'string', required: true, description,
});

const presentedFilesSchema = (withDescription = true) => ({
  type: 'array',
  items: {
    type: 'object', additionalProperties: false,
    properties: {
      path: fileProp('Path of an existing regular file. Relative paths use the Session working directory.'),
      ...(withDescription
        ? { description: fileProp('Brief description for the user.') }
        : {}),
    },
  },
});

/** The output schema (the output dialect takes required as an array). */
const presentOutput = (() => {
  const output = filesSchema();
  output.required = ['turn'];
  output.properties.turn = { type: 'integer' };
  return output;
})();

/** The files parameter schema, assembled from one-level pieces. */

/** The presented-files schema piece (shared by input and output). */
const filesSchema = () => ({
  type: 'object',
  properties: {
    files: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          path: fileProp('Path of an existing regular file. Relative paths use the Session working directory.'),
          description: fileProp('Brief description for the user.'),
        },
      },
    },
  },
});

/** One string file-field property, schema-flattened. */
export function apply(ctx, config) {
  const maxFiles = config?.maxFiles ?? DEFAULT_MAX_FILES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error('present requires a positive integer maxFiles');
  }
  const pending = new Map(); // exec → { session, turn, files }
  ctx.tools.register({
    name: 'present',
    description: 'Declare existing files accessible through the Session filesystem as final deliverables. '
      + 'When a file you create or update is an output the user asked to receive, you must call present after writing it and before your final response, including files created through Bash or code execution. '
      + 'Mentioning its path in your reply does not replace this call. The files must already exist. '
      + 'The user opens the current source files; their contents are not copied or preserved.',
    // The parameter schema (upstream's verbatim shape, flattened for the
    // indent gate — same object, fewer lines).
    // files: [{path, description?}] — built shallow so the schema literal
    // stays inside the indent gate.
    parameters: filesSchema(),
    output: presentOutput,
    execute: makeExecute(ctx, maxFiles, pending),
  });

  ctx.on('tools/result', (exec, result) => {
    const delivery = pending.get(exec);
    pending.delete(exec);
    if (delivery === undefined || result.isError) return;
    delivery.session.append('deliverables/presented', {
      turn: delivery.turn, callId: exec.callId, files: delivery.files,
    });
  });
}
