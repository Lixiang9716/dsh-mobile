// dsh:logging-exempt (pure data assembly; logging happens at the call site)
/**
 * web-live/boot-options.js — the composer seat's bootUpstream options
 * object, split from composer-web-live.js (first at the code-size gate,
 * now at testability: the boot-carrier regression test imports THIS file,
 * whose graph is empty — the composer module itself runs main() at import
 * and cannot be imported under vitest).
 *
 * The interactive rows + the creation/presetJoin flags. The llm face
 * forwards the route WHOLE: contextWindow included (the compaction
 * capacity, boot.js threads it into the adapter's resolveModel context).
 * The forward is load-bearing — measured on device 2026-10-10, the byok
 * route carried the capacity while this object dropped it, and the INITIAL
 * boot adapter stayed windowless ("step compaction failed: … no context
 * capacity …") until a save/clear rebind happened to rebuild it. The
 * defaults live in the route builders (llm-route.js): byokRoute's
 * credential-override → provider-row → fallback; stagedRoute's optional
 * llmContextWindow; the mock route stages none (scripted turns never
 * compact) and the field stays undefined — no invented capacity here.
 */
export const bootOptions = (cfg, route, root, extras) => ({
  scenario: extras.scenario,
  agentId: extras.agentId,
  sessionId: extras.sessionId,
  cwd: root,
  onEvent: extras.onEvent,
  // The interactive surfaces ("/" menu): rows delivered only by the
  // user-facing seat (SessionServe's interactive flag). The evidence drive
  // delivers neither row, so its boot stays byte-identical to the manifest.
  commands: cfg.commands === true,
  skills: cfg.skills,
  goals: cfg.goals === true,
  fileReferences: cfg.fileReferences === true,
  // The CREATION row (the creation-mode plugin): the present tool, under
  // the user-facing seat's interactive flag like the rows above.
  creation: cfg.creation === true,
  // The deployment default preset join (T-0048's shape): the boot agent
  // AND every session the page creates resolve tools/prompt/skills
  // against the joined composition, not the empty global layer — without
  // it a creation turn's write tool calls drop on the floor (measured
  // 2026-10-09: the session agent published onto an empty toolset).
  presetJoin: cfg.presetJoin === true,
  container: {
    cwd: root,
    tmpdir: `${root}/tmp`,
    home: `${root}/home`,
    // The granted scope's root: the fs shims map absolute paths onto
    // (scope, scope-relative path) through it. Absent on a host that grants
    // no scope, in which case the shims refuse rather than guess.
    scopeRoot: cfg.fsScopeRoot,
    env: { DSH_MOCK_LLM_URL: route.baseURL, DSH_MOCK_LLM_KEY: route.apiKey },
    argv: ['dsh', '--profile', 'mobile'],
  },
  llm: {
    baseURL: route.baseURL,
    apiKey: route.apiKey,
    provider: route.provider,
    model: route.model,
    contextWindow: route.contextWindow,
    userEndpoint: route.userEndpoint,
    adapterName: route.adapterName,
    transportLabel: route.transportLabel,
    onWire: (info) => extras.onEvent('llm/request/built', info),
    onSse: (info) => extras.onEvent('llm/sse', info),
  },
});
