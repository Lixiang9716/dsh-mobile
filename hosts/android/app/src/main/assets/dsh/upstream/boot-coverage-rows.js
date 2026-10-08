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

/** Join ONE live agent to the deployment default preset (the Agent 预设
 * policy's own default — `config.default`, `mobile` here). The staged gap
 * this closes: mountPresetPlane mounts the roster AFTER agent-loop, so the
 * configured boot agent publishes into the empty global layer — the vendored
 * service's own `agent/created` warning, and T-0048's tail item: the preset
 * rows (bash/pwsh/present/ralph) never joined the session toolset. The join
 * is the service's OWN mount primitive (resolve → standing mount → scope
 * bind), called at the point the caller knows the presets tree is seeded:
 * hosts that deliver the tree after the boot (the write leg's
 * agentPresets.seed ride) call this from their runtime half, not at mount
 * time. Fail loud (rule 5): an unresolvable or broken default preset names
 * itself — a seat that asks for the join staged no working roster.
 * @param ctx - the booted spine context.
 * @param agent - the live agent handle (ctx.agents.get).
 * @returns the composed preset.
 */
export const joinDefaultPreset = async (ctx, agent) => {
  const service = ctx.get('agentPresets');
  if (service === undefined) {
    throw new Error('boot: joinDefaultPreset needs the agentPresets service (mountPresetPlane)');
  }
  if (agent === undefined) {
    throw new Error('boot: joinDefaultPreset needs a live agent (ctx.agents.get)');
  }
  if (service.composedPreset(agent.ctx) !== undefined) {
    throw new Error(`boot: agent "${agent.id}" already joined preset "${service.composedPreset(agent.ctx)}"`);
  }
  return service.mount(agent.ctx, undefined);
};

/** The COMPOSITION host plane (the presetJoin seats, T-0048's tail item):
 * the services the deployment default composition's rows inject that neither
 * the spine nor the interactive flags mount — compaction-tool-result-pruner
 * parks without `tokenMeter`, tool-jobs without `jobs`, tool-ask-user
 * without `userQuestions`, the delegation group's tool-subagent refuses its
 * `modelSelectionSettings: true` row without `subagentModelSelection`, and
 * tool-bash parks without `shell` + `shellEnv`. A seat joining the default
 * preset boots this plane beside the interactive rows it already passes
 * (commands/goals/skills); every flagless leg stays byte-identical.
 *
 * `jobs` is the ABSTRACT registry seam (its constructor refuses) — the LOCAL
 * implementation backs it (the npm face staged at the dsh rel path, the
 * tool-web convention). `shell` is likewise the abstract executor seam: the
 * wasm executor (dsh-shell-wasm's exported `shellExecutor` — the backend the
 * ported dsh-shell subclass was always meant to wrap) backs the vendored
 * ShellExecutor here, background `start` refusing honestly (wasm runs are
 * foreground; background jobs still work through job-less direct calls).
 * `shellEnv` resolves its DSH_HOME onto the profile container the skills
 * plane already pins. The tool-workflow row is NOT backed: its engine rides
 * the PTC host runner (the mobile wall preset-mobile-rows.js disables the
 * row for) — no stub here would be honest. */
export const mountCompositionHostPlane = async (ctx, identity) => {
  const [TokenMeter, JobsLocal, UserQuestions, SubagentModelSelection,
    DshShell, DshShellEnv, ShellWasmPlugin] = await Promise.all([
    import('@deepseek-ai/dsh-token-meter'),
    import('@deepseek-ai/dsh-jobs-local'),
    import('@deepseek-ai/dsh-user-questions'),
    import('@deepseek-ai/dsh-tool-subagent/model-selection-settings'),
    import('@deepseek-ai/dsh-shell'),
    import('@deepseek-ai/dsh-shell-env'),
    import('system-plugins/dsh-shell-wasm/index.js'),
  ]);
  const WasmShellExecutor = class extends (DshShell.ShellExecutor ?? DshShell.default) {
    get sandboxMode() { return ShellWasmPlugin.shellExecutor.sandboxMode; }
    resolve(request) { return ShellWasmPlugin.shellExecutor.resolve(request); }
    run(request) { return ShellWasmPlugin.shellExecutor.run(request); }
    start() {
      return Promise.reject(new Error(
        'dsh-shell-wasm: background shell processes are not implemented on the wasm executor'));
    }
  };
  await ctx.plugin(TokenMeter.default ?? TokenMeter.TokenMeter, {});
  await ctx.plugin(JobsLocal.default ?? JobsLocal.LocalJobRegistry, {});
  await ctx.plugin(UserQuestions.default ?? UserQuestions.UserQuestionService, {});
  // The opt-in preference defaults OFF (enabled: false): the composition's
  // subagent rows mount, no per-child model selection policy rides until a
  // session enables it.
  await ctx.plugin(SubagentModelSelection.default
    ?? SubagentModelSelection.SubagentModelSelectionConfig, {});
  await ctx.plugin(WasmShellExecutor, {});
  const dshHome = identity.skills?.dshHome ?? globalThis.__dshProfileHome;
  await ctx.plugin(DshShellEnv.default ?? DshShellEnv.ShellEnvRegistry, { dshHome });
  const missing = ['tokenMeter', 'jobs', 'userQuestions', 'subagentModelSelection',
    'shell', 'shellEnv']
    .filter((name) => ctx.get(name) === undefined);
  if (missing.length > 0) {
    throw new Error(`boot: composition host plane failed to mount: ${missing.join(', ')}`);
  }
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
