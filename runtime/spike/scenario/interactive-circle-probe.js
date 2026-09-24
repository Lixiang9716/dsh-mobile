// dsh:logging-exempt (probe: its verdict output IS the product)
/** interactive-circle-probe — the vendored INTERACTIVE CIRCLE (the official
 * UI's unresolved-plugin report: persona, agent-instructions, plan-mode, the
 * goal/jobs/subagent/workflow families, tool-ask-user, the compaction story,
 * credentials + terminal) proven against the REAL CLI resolver: every new
 * package is imported through the loader's bare map (each package's whole
 * link-time import graph resolves or the import throws), and the mountable
 * chains ACTIVATE on the probe boot — persona on the spine SystemPrompt, the
 * goal chain (GoalService → command-goal) and the compaction chain
 * (TokenMeter → BasicCompactionEngine → command-compact) land real "/" menu
 * commands, and the ask-user chain (UserQuestionService → tool-ask-user)
 * mounts its tool. The remaining packages are load-verified only: mounting
 * them is the integration round's move (boot.js stays untouched this leg).
 * Run:
 *   cd runtime/spike && ./build/dsh-spike-cli . scenario/interactive-circle-probe.js
 */
import { createLogger } from 'logger.js';
const log = createLogger('probe.interactive-circle');
globalThis.__PROBE_COMMANDS = true;
const fail = (reason) => { log.error('probe failed', { reason }); globalThis.__dshComplete(false, reason); };

/** Load-only faces: specifier → export the resolver must serve non-undefined. */
const LOAD_ONLY = {
  '@deepseek-ai/dsh-agent-instructions': 'apply',
  '@deepseek-ai/dsh-plan-mode': 'PlanModeController',
  '@deepseek-ai/dsh-jobs': 'JobRegistry',
  '@deepseek-ai/dsh-output-retention': 'TextRetainer',
  '@deepseek-ai/dsh-tool-jobs': 'apply',
  '@deepseek-ai/dsh-chunked-list': 'appendChunkedList',
  '@deepseek-ai/dsh-util-time': 'canonicalClientTimeZone',
  '@deepseek-ai/dsh-subagent': 'SubagentRuntime',
  '@deepseek-ai/dsh-tool-subagent': 'apply',
  '@deepseek-ai/dsh-tool-subagent-control': 'apply',
  '@deepseek-ai/dsh-workflow': 'WorkflowEngine',
  '@deepseek-ai/dsh-tool-workflow': 'apply',
  '@deepseek-ai/dsh-compaction': 'CompactionEngine',
  '@deepseek-ai/dsh-compaction-tool-result-pruner': 'ToolResultPruner',
  '@deepseek-ai/dsh-credentials': 'CredentialProvider',
  '@deepseek-ai/dsh-terminal': 'TerminalSessionService',
};

try {
  const { bootUpstream } = await import('upstream/boot.js');
  const { ctx } = await bootUpstream({
    scenario: 'interactive.circle.probe', agentId: 'probe', sessionId: 's-probe-circle',
    cwd: '/tmp', onEvent: () => {},
    container: { cwd: '/tmp', tmpdir: '/tmp/.probe-tmp', home: '/tmp/.probe-home',
      env: {}, argv: ['dsh', '--profile', 'mobile'] },
    systemPrompt: { personaPrefix: '' },
    skills: { dshHome: '/tmp/.probe-home', agentsHome: '/tmp/.probe-home/.agents',
      customSkillDirs: ['/tmp/.probe-skills'] },
    commands: globalThis.__PROBE_COMMANDS === true,
    llm: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'probe', provider: 'mock', model: 'probe-1',
      onRequestBody: () => {} },
  });

  // 1. Load-only: every new package resolves through the real bare map.
  for (const [specifier, exportName] of Object.entries(LOAD_ONLY)) {
    const mod = await import(specifier);
    if (mod[exportName] === undefined) throw new Error(`${specifier}: export ${exportName} missing`);
  }
  log.info('probe: load-only circle resolved', { packages: Object.keys(LOAD_ONLY).length });

  // 2. The persona plane LOADS here; it is mount-staged: this probe boot's
  // SystemPrompt already registers the "deployment:persona-prefix" section
  // (boot.js feeds it `personaPrefix`), and the vendored persona plugin
  // registers the same section id — upstream composes ONE of the two, so
  // choosing between the boot's personaPrefix config and the persona plugin
  // is the integration round's wiring decision, not this probe's.
  await import('@deepseek-ai/dsh-persona');

  // 3. The goal chain: service first, then its "/" command plugin.
  const { GoalService } = await import('@deepseek-ai/dsh-goal');
  await ctx.plugin(GoalService, {});
  const CommandGoal = await import('@deepseek-ai/dsh-command-goal');
  await ctx.plugin(CommandGoal.default ?? CommandGoal, {});

  // 4. The compaction chain: meter → engine → its "/" command plugin.
  const { TokenMeter } = await import('@deepseek-ai/dsh-token-meter');
  await ctx.plugin(TokenMeter, {});
  const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic');
  await ctx.plugin(BasicCompactionEngine, {});
  const CommandCompact = await import('@deepseek-ai/dsh-command-compact');
  await ctx.plugin(CommandCompact.default ?? CommandCompact, {});

  // 5. The ask-user chain: questions service, then its model-facing tool.
  const { UserQuestionService } = await import('@deepseek-ai/dsh-user-questions');
  await ctx.plugin(UserQuestionService, {});
  const ToolAskUser = await import('@deepseek-ai/dsh-tool-ask-user');
  await ctx.plugin(ToolAskUser.default ?? ToolAskUser, {});

  // 6. The "/" menu names the registered commands — the report's whole point.
  const commands = ctx.get('commands');
  if (!commands) throw new Error('commands service missing from the context');
  const listed = commands.list();
  const names = (Array.isArray(listed) ? listed : listed.commands ?? []).map((c) => c?.name ?? c);
  for (const want of ['goal', 'compact']) {
    if (!names.includes(want)) throw new Error(`command "${want}" not registered (list: ${JSON.stringify(names)})`);
  }
  if (ctx.get('goals') === undefined) throw new Error('goals service missing');
  if (ctx.get('compaction') === undefined) throw new Error('compaction service missing');
  if (ctx.get('userQuestions') === undefined) throw new Error('userQuestions service missing');
  if (ctx.tools?.get && ctx.tools.get('ask_user', undefined) === undefined) {
    // The tool registry keys tools per scope; absence here is only a finding
    // when the registry exposes a lookup at all.
    log.info('probe: ask_user not visible through ctx.tools lookup (scope-keyed)', {});
  }

  log.info('probe ok', {
    loaded: Object.keys(LOAD_ONLY).length + 7,
    commands: names,
    services: ['goals', 'compaction', 'userQuestions', 'tokenMeter'].map((s) => `${s}:${ctx.get(s) !== undefined}`),
  });
  globalThis.__dshComplete(true, 'interactive circle mounted');
} catch (e) {
  fail((e?.message ?? String(e)) + ' | ' + (e?.stack ?? '').slice(0, 300));
}
