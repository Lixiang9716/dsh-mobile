// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * agent-presets-probe.js — the fs-promises shim + presets seed + mount chain,
 * driven the way the panel will. Not an E2E manifest fixture: this is the
 * composition probe for the Agent 预设 work. Seed comes from
 * agent-presets-probe-seed.json (generated from the vendored presets tree);
 * the same bytes a driver would deliver over the bus.
 */
import { createLogger } from 'logger.js';
import { bootUpstream } from 'upstream/boot.js';
import { mergeWebPlugins } from 'upstream/shims/fs.js';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { AgentPresets } from '@deepseek-ai/dsh-agent-presets';
import seedManifest from './agent-presets-probe-seed.js';

const log = createLogger('agent-presets.probe');
const emit = (event, fields = {}) => log.info('probe', { event, ...fields });

const root = globalThis.__dshProfileCwd ?? '/tmp';

// Seed the vendored presets tree into the fs VFS (the same delivery shape the
// web-plugins bus message uses, under the widened /vendor root).
mergeWebPlugins(seedManifest);
emit('seeded', { files: Object.keys(seedManifest).length });

const { ctx } = await bootUpstream({
  scenario: 'agent-presets.probe',
  agentId: 'probe-agent',
  sessionId: 'probe-session',
  cwd: root,
  onEvent: emit,
  container: {
    cwd: root,
    tmpdir: `${root}/tmp`,
    home: `${root}/home`,
    scopeRoot: root,
    env: {},
    argv: ['dsh', '--profile', 'mobile'],
  },
  llm: {
    baseURL: 'http://127.0.0.1:1', apiKey: 'probe', provider: 'mock', model: 'mock-1',
  },
});

emit('mounted', { service: ctx.get('agentPresets') !== undefined });

const service = ctx.get('agentPresets');
const roster = await service.remoteExportList();
emit('roster', {
  presets: (roster.presets ?? []).map((p) => p.id ?? p.name ?? p.path),
  keys: Object.keys(roster),
});
for (const row of roster.presets ?? []) {
  emit('preset', { row: { id: row.id, name: row.name, broken: row.broken ?? row.unusable ?? null } });
}

globalThis.__dshComplete(true);
