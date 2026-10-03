// dsh:logging-exempt (boot rows split from boot.js at the file-size gate —
// same posture as boot.js itself: logging happens through the mounted logger)
/**
 * upstream/boot-coverage-rows.js — the OPTIONAL boot rows (the commands /
 * goals / file-references / creation work streams), split from boot.js's
 * mountSpine at the code-size gate (2026-10-03, #323's guard rings pushed
 * the file past 500 lines). Behavior is carried verbatim: same dynamic
 * imports (the npm-bridges must register before these specifiers resolve),
 * same mount order relative to the spine rows, same gated mount flags.
 */
/** The COMMAND row (2026-09-24, the owner's "/" report): the upstream
 * interactive-command registry (dsh-commands) plus the command-defining
 * plugins the desktop composition mounts (command-feedback first — its deps
 * are already vendored). Commands are plugin-owned: the registry carries no
 * built-ins, so the surface is only as rich as the plugins mounted after it.
 * Mounted only when the caller configures `options.commands` (the user-facing
 * seat), so every existing spine leg boots byte-identically. The registry
 * must precede the command-defining plugins (they register into it). */
const mountCommandPlane = async (ctx) => {
  const [Commands, CommandFeedback] = await Promise.all([
    import('@deepseek-ai/dsh-commands'),
    import('@deepseek-ai/dsh-command-feedback'),
  ]);
  await ctx.plugin(Commands.default ?? Commands, {});
  await ctx.plugin(CommandFeedback.default ?? CommandFeedback, {});
};

/** The GOAL row (api-full-coverage work stream): the vendored event-sourced
 * GoalService (`ctx.goals`, dsh-goal) — the service the official UI's
 * goals/* Remote namespace reads. Its injects (`agents`,
 * `sessionProjections`) are both mounted above, so the mount is a plain
 * plugin application; it registers its projection and arms its
 * `agent/created` listener at apply time. */
const mountGoalPlane = async (ctx) => {
  const Goal = await import('@deepseek-ai/dsh-goal');
  await ctx.plugin(Goal.default ?? Goal.GoalService, {});
};

/** The /goal row (agent.cordis.yml row 91): dsh-command-goal injects
 * ["commands", "goals"] — it mounts AFTER the goal plane for that inject
 * order (command plane runs first above), on the interactive flags only so
 * drive legs stay byte-identical. */
const mountGoalCommand = async (ctx) => {
  const CommandGoal = await import('@deepseek-ai/dsh-command-goal');
  await ctx.plugin(CommandGoal.default ?? CommandGoal, {});
};

/** The FILE-REFERENCE row (same work stream): the vendored local-filesystem
 * file-reference discovery service (`ctx.fileReferences`,
 * dsh-file-reference-local) — the @-mention lexicon the official composer
 * reads (`fileReferences/list`). Injects `agents` only; its search walks the
 * node:fs/promises shim, i.e. the SAME pinned workspace world the `fs`
 * service serves. */
const mountFileReferencePlane = async (ctx) => {
  const FileRefs = await import('@deepseek-ai/dsh-file-reference-local');
  await ctx.plugin(FileRefs.default ?? FileRefs.LocalFileReferenceService, {});
};

/** The gated coverage/creation rows, in mountSpine's order (call it where
 * the inline block used to sit). `identity` carries the boot flags:
 * commands / goals / fileReferences / creation. */
export const mountCoverageRows = async (ctx, identity) => {
  if (identity.commands) await mountCommandPlane(ctx);
  // The COVERAGE rows (api-full-coverage work stream): gated mounts of the
  // vendored goal service and file-reference discovery service, each AFTER
  // agent-loop (both inject `agents`; goals also reads `sessionProjections`).
  if (identity.goals) await mountGoalPlane(ctx);
  if (identity.goals && identity.commands) await mountGoalCommand(ctx);
  if (identity.fileReferences) await mountFileReferencePlane(ctx);
  // The CREATION row (the creation-mode plugin, 2026-09-26): the present
  // tool registers into `tools` at apply time, so it mounts with the other
  // tools — before the agent loop. Only when configured.
  if (identity.creation) {
    const Present = await import('upstream/tool-present.js');
    await ctx.plugin(Present, { maxFiles: 8 });
  }
};
