#!/usr/bin/env node
// dsh:logging-exempt (E2E UI-automation driver: a dev script whose console
// output IS the drive evidence — same standing as test/e2e/check.mjs)
/**
 * drive-official.mjs — driver for the D9 official phases on the local
 * HarmonyOS emulator (the harmony twin of test/e2e/run-ios-official-web-mount.sh's wait
 * loop). It tails the hilog stream and, event by event, takes the evidence
 * screenshots and waits for the terminal markers (rules.md rule 8: every
 * wait is a polled condition with a deadline; every exhaustion fails loud).
 * No taps: the official-web phases are driverless — the page boots itself.
 *
 *   harmony.officialweb.mount index.served → boot-screen screenshot
 *   harmony.officialweb.mount mount.complete → final screenshot
 *   harmony.session.live-read      index.served → session boot screenshot
 *   harmony.session.live-read      session.live.complete → session screenshot
 *   harmony.composer.live-write        index.served → write boot screenshot
 *   harmony.composer.live-write        composer.typed → composer-typed screenshot
 *   harmony.composer.live-write        write.reply.rendered → reply-rendered screenshot
 *   dsh.runtime.verdict: harmony.httpfetch-streaming     → leg done
 *   dsh.runtime.verdict: harmony.session.live-read     → leg done
 *   dsh.runtime.verdict: harmony.composer.live-write       → done (exit 0 on PASS)
 *
 * The terminal wait rides BOTH surfaces: the hilog stream AND the on-device
 * capture files. hilog flow control can drop stream lines entirely even
 * with `-Q pidoff/domainoff` applied (measured 2026-10-08: the write leg's
 * markers and all three verdict lines never surfaced on the stream while
 * every leg had completed on-device — the checkers' capture files carried
 * the terminal verdicts), so when the stream has not delivered, the poll
 * greps the same capture files the checkers judge. Screenshots stay
 * stream-only: they are evidence, never a pass condition.
 *
 * usage: drive-official.mjs --hdc <path> [--overall-deadline S]
 *                            [--capture-base DIR]
 *                            [--shot-boot PNG] [--shot-final PNG]
 *                            [--shot-session-boot PNG] [--shot-session PNG]
 *                            [--shot-write-boot PNG] [--shot-write-composer PNG]
 *                            [--shot-write-reply PNG]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const usage = () => {
  console.error('usage: drive-official.mjs --hdc <path> [--overall-deadline S]' +
    ' [--shot-boot PNG] [--shot-final PNG]' +
    ' [--shot-session-boot PNG] [--shot-session PNG]' +
    ' [--shot-write-boot PNG] [--shot-write-composer PNG] [--shot-write-reply PNG]');
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
// The on-device capture files (run-host-e2e.sh pulls exactly these): the
// stream-independent surface the terminal wait falls back to.
const CAPTURE_BASE = args['capture-base'] ??
  '/data/app/el2/100/base/com.dshmobile.host/haps/entry/cache';
const CAPTURE_FILES = {
  official: `${CAPTURE_BASE}/dsh-official-capture.log`,
  httpfetch: `${CAPTURE_BASE}/dsh-httpfetch-capture.log`,
  session: `${CAPTURE_BASE}/dsh-session-capture.log`,
  write: `${CAPTURE_BASE}/dsh-write-capture.log`,
};

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
  sessionBootShot: false,
  sessionDone: false,
  sessionShot: false,
  writeBootShot: false,
  writeComposerShot: false,
  writeDone: false,
  writeComposerWaited: false,
  writeReplyShot: false,
  verdict: null,
  sessionVerdict: null,
  writeVerdict: null,
};

const onLine = (line) => {
  if (line.includes('"event":"index.served"') &&
      line.includes('harmony.officialweb.mount') && !state.bootShot) {
    state.bootShot = true;
    // The application tier activates in seconds; shoot immediately (the
    // boot screen is the evidence — same posture as run-ios-official-web-mount.sh).
    snapshot(args['shot-boot']);
  }
  if (line.includes('"event":"mount.complete"') && !state.mountDone) {
    state.mountDone = true;
    snapshot(args['shot-final']);
  }
  if (line.includes('"event":"index.served"') &&
      line.includes('harmony.session.live-read') && !state.sessionBootShot) {
    state.sessionBootShot = true;
    snapshot(args['shot-session-boot']);
  }
  if (line.includes('"event":"session.live.complete"') && !state.sessionDone) {
    state.sessionDone = true;
    snapshot(args['shot-session']);
  }
  if (line.includes('"event":"index.served"') &&
      line.includes('harmony.composer.live-write') && !state.writeBootShot) {
    state.writeBootShot = true;
    snapshot(args['shot-write-boot']);
  }
  if (line.includes('"event":"composer.typed"') &&
      line.includes('harmony.composer.live-write') && !state.writeComposerShot) {
    state.writeComposerShot = true;
    // The carrier paces ~2.5s between this line and the send; a short
    // settle lets the composer render the IME state before the capture.
    setTimeout(() => {
      snapshot(args['shot-write-composer']);
      state.writeComposerWaited = true;
    }, 1200);
  }
  if (line.includes('"event":"write.reply.rendered"') && !state.writeReplyShot) {
    state.writeReplyShot = true;
    snapshot(args['shot-write-reply']);
  }
  if (line.includes('dsh.runtime.verdict: harmony.httpfetch-streaming')) {
    state.verdict = line.includes(' PASS ') ? 'pass' : 'fail';
  }
  if (line.includes('dsh.runtime.verdict: harmony.session.live-read')) {
    state.sessionVerdict = line.includes(' PASS') ? 'pass' : 'fail';
  }
  if (line.includes('dsh.runtime.verdict: harmony.composer.live-write')) {
    state.writeVerdict = line.includes(' PASS') ? 'pass' : 'fail';
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

/** One capture-file grep over hdc shell: the matching line's text, or ''.
 * `hdc shell` reports rc=0 whatever the remote command returns, so the
 * OUTPUT is the answer (the runner's own rule). */
const grepCapture = (file, needle) => new Promise((resolve) => {
  const child = spawn(args.hdc,
    ['shell', `grep -s ${JSON.stringify(needle)} ${file}`],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
  child.on('error', () => resolve(''));
  child.on('close', () => resolve(out.trim()));
});

// The capture-file fallback, probed at most every 4s (each probe is a fresh
// hdc shell round-trip; the drive's own poll paces at 500ms).
let captureProbedAt = 0;
const captureFallback = async () => {
  if (Date.now() - captureProbedAt < 4000) {
    return;
  }
  captureProbedAt = Date.now();
  const [mount, httpfetch, session, write] = await Promise.all([
    grepCapture(CAPTURE_FILES.official, '"event":"mount.complete"'),
    grepCapture(CAPTURE_FILES.httpfetch,
      'dsh.runtime.verdict: harmony.httpfetch-streaming'),
    grepCapture(CAPTURE_FILES.session,
      'dsh.runtime.verdict: harmony.session.live-read'),
    grepCapture(CAPTURE_FILES.write,
      'dsh.runtime.verdict: harmony.composer.live-write'),
  ]);
  if (mount && !state.mountDone) state.mountDone = true;
  if (httpfetch && state.verdict === null) {
    state.verdict = httpfetch.includes(' PASS ') ? 'pass' : 'fail';
  }
  if (session && state.sessionVerdict === null) {
    state.sessionVerdict = session.includes(' PASS') ? 'pass' : 'fail';
  }
  if (write && state.writeVerdict === null) {
    state.writeVerdict = write.includes(' PASS') ? 'pass' : 'fail';
  }
};

pollUntil('b-harmony verdicts', async () => {
  if (!(state.mountDone && state.verdict !== null &&
      state.sessionVerdict !== null && state.writeVerdict !== null)) {
    await captureFallback();
  }
  return state.mountDone && state.verdict !== null && state.sessionVerdict !== null &&
      state.writeVerdict !== null
    ? [state.verdict, state.sessionVerdict, state.writeVerdict]
    : null;
}, OVERALL).then((verdicts) => {
  stream.kill();
  if (verdicts[0] !== 'pass') {
    die(`httpfetch-v2 verdict ${verdicts[0]}`);
  }
  if (verdicts[1] !== 'pass') {
    die(`session.live verdict ${verdicts[1]}`);
  }
  if (verdicts[2] !== 'pass') {
    die(`write.live verdict ${verdicts[2]}`);
  }
  console.log('drive-official: PASS (mount.complete + harmony.httpfetch-streaming ' +
    '+ harmony.session.live-read + harmony.composer.live-write verdicts)');
  process.exit(0);
}).catch((e) => die(e.message));
