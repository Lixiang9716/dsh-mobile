/**
 * Scenario `create.card` — the create-approve-hotmount loop's E2E leg
 * (PR-2/PR-3): invokes dsh-create's plugin_create execute directly (the
 * same function the agent loop dispatches through ctx.tools; the scripted
 * tool-call half is the mock's PLUGIN_CREATE_TURN leg). The chain it
 * proves, on the REAL seat:
 *
 *   package written (workspace plugins/<name>/) → NATIVE presentApproval
 *   (a human finger taps Approve — the drive does) → registry row
 *   installed (dsh.plugins/1) → the LIVE card face (card.present/state/
 *   complete over the bus, one-shot timer re-arm ticks) → the native
 *   CardPlayerSurface renders the pomodoro in the app's own chrome.
 *
 * The duration is deliberately short (the evidence window; the real chat
 * passes 1500000 for a full 25-minute pomodoro).
 */
import { createLogger } from '../logger.js';
import { scenarioModule } from '../transport-tokens.mjs';
import { pluginCreateExecute } from 'system-plugins/dsh-create/index.js';

const SCENARIO = 'create.card';
const log = createLogger(scenarioModule);
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  log.debug('scenario failed', { reason });
  emit('scenario.failed', { reason });
  globalThis.__dshComplete(false, reason);
};

const DURATION_MS = 8000;

emit('create.card.begin', {});
if (!globalThis.__dshGatewayNegotiate('gateway@1')) {
  fail('gateway negotiation failed');
} else {
  emit('create.card.seat.ready', { gateway: 'gateway@1' });

  // The bare seat pins no profile globals; workspacePrefix's tolerant bare
  // spelling (workspace-registry.js) scopes every path at the app root —
  // exactly what this drive needs.

  const result = await pluginCreateExecute({
    name: 'pomodoro-create',
    title: '番茄时钟 · 创作',
    kind: 'timer',
    durationMs: DURATION_MS,
  });
  emit('tool.returned', {
    ok: typeof result === 'string' && result.includes('已安装并激活'),
    text: typeof result === 'string' ? result.slice(0, 80) : String(result),
  });
  if (!(typeof result === 'string' && result.includes('已安装并激活'))) {
    fail(`plugin_create did not install: ${JSON.stringify(result)}`);
  } else {
    // The card face runs fire-and-forget; let the ticks land (present +
    // a few states + complete at DURATION_MS), then settle.
    await new Promise((resolve) => setTimeout(resolve, DURATION_MS + 1500));
    emit('create.card.done', { durationMs: DURATION_MS });
    emit('scenario.complete', { status: 'pass' });
    globalThis.__dshComplete(true, 'create.card settled');
  }
}
