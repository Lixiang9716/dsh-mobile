// W4-N probe 7: reproduce the verify-path Invalid URL with a raw stack.
import 'upstream/web-shims.js';
import 'upstream/shims/process.js';
import { createLogger } from 'logger.js';
import { fsScope } from 'gateway.js';

const log = createLogger('m2.spike');
const resolved = await fsScope.resolve('scope://app/');
globalThis.__dshProfileCwd = resolved.path;
globalThis.__dshProfileTmpdir = resolved.path.replace(/\/$/, '') + '/tmp';
globalThis.__dshProfileHome = resolved.path.replace(/\/$/, '') + '/home';
const { mountWorkspace } = await import('upstream/shims/fs.js');
mountWorkspace(globalThis.__dshProfileTmpdir);
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');

const root = fs.mkdtempSync(join2(os.tmpdir(), 'dsh-spill-'));
function join2(a, b) { return a.replace(/\/$/, '') + '/' + b; }

// Build a minimal valid V3 log file.
const dir = path.join(root, 'session-probe');
fs.mkdirSync(dir, { recursive: true });
const header = JSON.stringify({ type: 'session', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: 0, version: 3, isSeeded: false, delegationDepth: 0 });
const file = path.join(dir, 'session.v3.jsonl');
fs.writeFileSync(file, header + '\n');

const generation = await import('/vendor/dsh/session-persistence-jsonl@0.1.6-alpha.2/lib/generation.js');
try {
  const result = await generation.verifyJsonlCurrentGeneration(file, 'none', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, undefined);
  log.info('e2e', { scenario: 'w4n.probe7', event: 'verify-ok', bytes: result.bytes });
} catch (error) {
  log.info('e2e', { scenario: 'w4n.probe7', event: 'verify-fail', msg: String(error?.message), stack: String(error?.stack).slice(0, 800) });
}
globalThis.__dshComplete(true, 'probe7 done');
