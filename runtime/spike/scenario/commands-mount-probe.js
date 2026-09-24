// dsh:logging-exempt (probe: its verdict output IS the product)
/** commands-mount-probe — the "/" surface's runtime half, verified in
 * isolation: the vendored dsh-commands registry + dsh-command-feedback mount
 * as cordis plugins (the CLI composition's shape) and the registry service
 * lands on the context. Run:
 *   cd runtime/spike && ./build/dsh-spike-cli . scenario/commands-mount-probe.js
 */
import { createLogger } from 'logger.js';
const log = createLogger('probe.commands');
globalThis.__PROBE_COMMANDS = true;
const fail = (reason) => { log.error('probe failed', { reason }); globalThis.__dshComplete(false, reason); };
try {
  const { bootUpstream } = await import('upstream/boot.js');
  const { ctx } = await bootUpstream({
    scenario: 'commands.probe', agentId: 'probe', sessionId: 's-probe-cmd',
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
  const commands = ctx.get('commands');
  if (!commands) throw new Error('commands service missing from the context');
  const listed = typeof commands.list === 'function';
  log.info('probe ok', { hasService: true, listable: listed });
  globalThis.__dshComplete(true, 'commands mounted');
} catch (e) {
  fail((e?.message ?? String(e)) + ' | ' + (e?.stack ?? '').slice(0, 300));
}
