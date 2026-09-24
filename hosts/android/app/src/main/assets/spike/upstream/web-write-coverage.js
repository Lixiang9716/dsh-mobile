// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-coverage.js — the COVERAGE composition (decision D9,
 * api-full-coverage work stream): the endpoint/stream lists and the api-map
 * assembly for the full namespace surface, split out of web-write.js at the
 * code-size gate. Every handler forwards to the real vendored service boot.js
 * mounted for it (see the per-adapter module headers); nothing here
 * reimplements. Claimed ONLY when the write options carry
 * `fullCoverage: true` — the historical claim rows stay byte-identical, so
 * the delivered manifests that pin the claim set are not disturbed until the
 * drives opt in.
 */
import {
  makeWorkspaceFileHandlers,
  makeWorkspaceListHandler,
  createChangeFeed,
  resolveScopeRoot,
} from 'upstream/web-write-files.js';
import { makeDirectoryPickerList, makeDirectoryPickerCreate } from 'upstream/web-write-picker.js';
import { makeWorkspaceHandlers } from 'upstream/web-write-workspace.js';
import { makeSkillsHandlers,
  makeFileReferenceHandlers,
  makeGoalHandlers,
  makeCommandHandlers,
} from 'upstream/web-write-catalog.js';
import { buildLlmCoverageApi } from 'upstream/web-write-llm.js';
import { errorOf } from 'upstream/web-write.js';

/**
 * The COVERAGE endpoints, per backing service. Still honestly unimplemented
 * (no handler; the carrier answers gateway/unimplemented): terminal/* (a
 * persistent PTY needs a process seam the gateway primitives do not offer),
 * directoryPicker/pick (the native OS chooser), settings/replace|
 * openSettingsDocument|openAgentPresetDirectory (desktop OS/document
 * surfaces; canOpenAgentPresetDirectory answers `false` so the page hides
 * the opener), and the session/* legs this profile does not serve
 * (page/search/fork/attachment/cancel/updateQueue/rename/selectModel/
 * openWorkspacePath). The LLM + credential rows live in web-write-llm.js:
 * the provider directory off the mounted LlmRuntime, the credential store
 * in the profile container (the superseded not-writable stance), and the
 * opener gate.
 */
export const COVERAGE_ENDPOINTS = [
  // The file sidebar + preview (over the vendored fs service).
  'workspaceFiles/stat', 'workspaceFiles/list', 'workspaceFiles/read',
  'workspaceFiles/readAll', 'workspaceFiles/readBytes', 'workspaceFiles/readRelated',
  // The workspace sidebar's mutations + archive set (over the in-memory
  // registry the workspace/follow baseline already serves).
  'workspace/create', 'workspace/delete', 'workspace/rename',
  'workspace/insertBefore', 'workspace/insertSessionBefore',
  'workspace/archiveSession', 'workspace/unarchiveSession',
  // The in-app directory browser (browse capability only; pick stays off).
  'directoryPicker/list', 'directoryPicker/createDirectory',
  // The "/" skill candidates + @-mention lexicon (vendored registries).
  'skills/list', 'fileReferences/list',
  // The goal panel (vendored dsh-goal GoalService).
  'goals/get', 'goals/create', 'goals/edit', 'goals/pause', 'goals/resume',
  'goals/complete', 'goals/clear',
  // The "/" command palette (vendored dsh-commands registry).
  'commands/list', 'commands/execute',
  // The 设置 → 模型 page's provider join (mounted LlmRuntime) + the
  // credential store write half (web-write-llm.js; supersedes the earlier
  // not-writable-through-the-wire stance) + the desktop-opener gate.
  'llm/listProviders', 'llm/listConfigurableProviders',
  'credentials/set', 'credentials/unset',
  'settings/canOpenAgentPresetDirectory',
];

/** The COVERAGE streams: the workspace file change feed. */
export const COVERAGE_STREAMS = ['workspaceFiles/changes'];

/**
 * The coverage api map: every COVERAGE endpoint's handler, each backed by
 * the real service boot.js mounted (see the per-module headers).
 */
export const buildCoverageApi = (ctx, deps) => ({
  ...makeWorkspaceFileHandlers(ctx, deps),
  'workspaceFiles/list': makeWorkspaceListHandler(ctx, deps),
  ...makeWorkspaceHandlers(ctx, deps),
  'directoryPicker/list': makeDirectoryPickerList(ctx, deps),
  'directoryPicker/createDirectory': makeDirectoryPickerCreate(ctx, deps),
  ...makeSkillsHandlers(ctx),
  ...makeFileReferenceHandlers(ctx),
  ...makeGoalHandlers(ctx),
  ...makeCommandHandlers(ctx),
  ...buildLlmCoverageApi(ctx, deps),
});

/**
 * The coverage mux stream open leg: one `workspaceFiles/changes` open
 * resolves its session's workspace root and attaches the change feed.
 * Everything else falls through (the caller answers unimplemented). The
 * wrapped msg carries `cancelled()` and `attachUnsubscribe(fn)` — the
 * registry entry is the caller's; a stream cancelled before the root
 * resolves attaches nothing.
 */
export const openCoverageStream = (ctx, deps, changeFeed, post, msg) => {
  if (msg.endpoint !== 'workspaceFiles/changes') return undefined;
  const attach = async () => {
    const unsubscribe = await changeFeed.follow(
      resolveScopeRoot(ctx, deps, msg.payload?.args?.workspaceFileScopeId),
      (frame) => post({ type: 'mux.item', streamId: msg.streamId, value: frame }),
      msg.cancelled);
    msg.attachUnsubscribe(unsubscribe);
  };
  attach().catch((error) => {
    const wire = errorOf(error);
    post({ type: 'mux.error', streamId: msg.streamId,
      code: wire.code, message: wire.message, details: wire.details });
    msg.attachUnsubscribe(() => {});
  });
  return { kind: 'attached', endpoint: msg.endpoint };
};

/** The change feed factory, re-exported for the surface's late binding. */
export { createChangeFeed };
