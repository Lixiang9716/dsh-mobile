#!/usr/bin/env node
// dsh:logging-exempt (E2E UI-automation driver: a dev script whose console
// output IS the drive evidence — same standing as tools/e2e/check.mjs)
/**
 * drive-official.mjs — driver for the D9 official-web-mount phases on the
 * local HarmonyOS emulator (the harmony twin of tools/e2e/run-ios-b1.sh's
 * wait loop). It tails the hilog stream and, event by event, takes the
 * evidence screenshots and waits for the terminal markers (rules.md rule 8:
 * every wait is a polled condition with a deadline; every exhaustion fails
 * loud). No taps: the official-web phase is driverless — the page boots
 * itself.
 *
 *   b-harmony.official-web-mount index.served → boot-screen screenshot
 *   b-harmony.official-web-mount mount.complete → final screenshot
 *   dsh.spike.verdict: b-harmony.httpfetch-v2 → done (exit 0 on PASS)
 *
 * usage: drive-official.mjs --hdc <path> [--overall-deadline S]
 *                            [--shot-boot PNG] [--shot-final PNG]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const usage = () => {
  console.error('usage: drive-official.mjs --hdc <path> [--overall-deadline S]' +
    ' [--shot-boot PNG] [--shot-final PNG]');
  process.exit(2);
};

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) usage();
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!args.hdc) usage();

const OVERALL = Number(args['overall-deadline'] ?? 420) * 1000;
const startedAt = Date.now();
const work = mkdtempSync(join(tmpdir(), 'dsh-drive-official-'));

const die = (msg) => {
  console.error(`drive-official: FAIL ${msg}`);
  process.exit(1);
};
const hdcHere = (cmd, opts = {}) =>
  execFileSync(args.hdc, cmd, { encoding: 'utf8', ...opts }).trim();

const pollUntil = async (what, probe, ms) => {
  const deadline = startedAt + OVERALL;
  const budget = Math.min(ms, Math.max(deadline - Date.now(), 0));
  const at = Date.now() + budget;
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() > at) {
      die(`${what}: deadline elapsed after ${Math.round(budget / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
};

const snapshot = (file) => {
  if (!file) {
    return;
  }
  try {
    execFileSync(args.hdc,
      ['shell', 'snapshot_display', '-f', '/data/local/tmp/dsh-official-shot.jpeg']);
    hdcHere(['file', 'recv', '/data/local/tmp/dsh-official-shot.jpeg', file]);
    console.log(`drive-official: screenshot -> ${file}`);
  } catch (e) {
    console.error(`drive-official: snapshot failed (non-fatal): ${e.message}`);
  }
};

// ---- the event loop ---------------------------------------------------------

const state = {
  bootShot: false,
  mountDone: false,
  finalShot: false,
  verdict: null,
};

const onLine = (line) => {
  if (line.includes('"event":"index.served"') &&
      line.includes('b-harmony.official-web-mount') && !state.bootShot) {
    state.bootShot = true;
    // The application tier activates in seconds; shoot immediately (the
    // boot screen is the evidence — same posture as run-ios-b1.sh).
    snapshot(args['shot-boot']);
  }
  if (line.includes('"event":"mount.complete"') && !state.mountDone) {
    state.mountDone = true;
    snapshot(args['shot-final']);
  }
  if (line.includes('dsh.spike.verdict: b-harmony.httpfetch-v2')) {
    state.verdict = line.includes(' PASS ') ? 'pass' : 'fail';
  }
};

const stream = spawn(args.hdc, ['shell', 'hilog'], { stdio: ['ignore', 'pipe', 'ignore'] });
let buffer = '';
stream.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    onLine(line);
  }
});
stream.on('exit', () => die('hilog stream ended early'));

pollUntil('b-harmony verdicts', async () => {
  return state.mountDone && state.verdict !== null ? state.verdict : null;
}, OVERALL).then((verdict) => {
  stream.kill();
  if (verdict !== 'pass') {
    die(`httpfetch-v2 verdict ${verdict}`);
  }
  console.log('drive-official: PASS (mount.complete + b-harmony.httpfetch-v2 verdict)');
  process.exit(0);
}).catch((e) => die(e.message));
