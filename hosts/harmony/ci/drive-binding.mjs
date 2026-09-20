#!/usr/bin/env node
// dsh:logging-exempt (E2E UI-automation driver: a dev script whose console
// output IS the drive evidence — same standing as tools/e2e/check.mjs)
/**
 * drive-binding.mjs — UI-automation driver for the m5.host-binding phase on
 * the local HarmonyOS emulator. It tails the hilog stream and, event by
 * event, drives the surfaces that need a human hand (rules.md rule 8: every
 * wait is a polled condition with a deadline; every exhaustion fails loud):
 *
 *   ui-wait notification-permission  → tap the system Allow button (if the
 *                                      consent dialog is up; a granted
 *                                      install passes straight through)
 *   ui-wait approval                 → tap the custom dialog's Approve
 *   ui-done notify-scheduled         → Home (background edge) → open the
 *                                      notification shade → tap the DSH
 *                                      notification (wantAgent → response +
 *                                      foreground edges)
 *   dsh.spike.verdict: m5.host-binding → done (exit 0 on PASS)
 *
 * tools/ dev script (out of the logging gate's scope; console IS the
 * product). It never asserts on pixels — screenshots are local evidence.
 *
 * usage: drive-binding.mjs --hdc <path> [--overall-deadline S]
 *                          [--shot-live PNG] [--shot-final PNG]
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const usage = () => {
  console.error('usage: drive-binding.mjs --hdc <path> [--overall-deadline S]' +
    ' [--shot-live PNG] [--shot-final PNG]');
  process.exit(2);
};

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) usage();
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!args.hdc) usage();

const OVERALL = Number(args['overall-deadline'] ?? 300) * 1000;
const STEP = 30_000;
const POLL = 500;
const LAYOUT_REMOTE = '/data/local/tmp/dsh-drive-layout.json';
const startedAt = Date.now();
const work = mkdtempSync(join(tmpdir(), 'dsh-drive-'));

const die = (msg) => {
  console.error(`drive: FAIL ${msg}`);
  process.exit(1);
};
const shell = (cmd, opts = {}) =>
  execFileSync(args.hdc, ['shell', cmd], { encoding: 'utf8', ...opts }).trim();
const hdcHere = (cmd, opts = {}) =>
  execFileSync(args.hdc, cmd, { encoding: 'utf8', ...opts }).trim();

const deadlineLeft = (ms) => {
  const left = startedAt + OVERALL - Date.now();
  return Math.min(ms ?? STEP, Math.max(left, 0));
};

/** Poll `probe` until it returns a truthy value or the deadline passes.
 * soft: resolve null on exhaustion instead of dying (best-effort taps). */
const pollUntil = async (what, probe, ms, soft = false) => {
  const budget = deadlineLeft(ms);
  const deadline = Date.now() + budget;
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      if (soft) {
        return null;
      }
      die(`${what}: deadline elapsed after ${Math.round(budget / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, POLL));
  }
};

const dumpLayout = () => {
  shell(`uitest dumpLayout -p ${LAYOUT_REMOTE}`);
  const local = join(work, 'layout.json');
  hdcHere(['file', 'recv', LAYOUT_REMOTE, local]);
  return JSON.parse(readFileSync(local, 'utf8'));
};

const boundsCenter = (bounds) => {
  const m = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(bounds);
  if (!m) {
    return null;
  }
  return { x: Math.round((Number(m[1]) + Number(m[3])) / 2),
    y: Math.round((Number(m[2]) + Number(m[4])) / 2) };
};

const findText = (node, regex) => {
  if (node?.attributes && regex.test(node.attributes.text ?? '')) {
    const center = boundsCenter(node.attributes.bounds);
    if (center) {
      return center;
    }
  }
  for (const child of node?.children ?? []) {
    const hit = findText(child, regex);
    if (hit) {
      return hit;
    }
  }
  return null;
};

const tapText = async (what, regex, ms, soft = false) => {
  const at = await pollUntil(what, () => {
    try {
      return findText(dumpLayout(), regex);
    } catch {
      return null; // transient dump failures (window transitions) — keep polling
    }
  }, ms, soft);
  if (at === null) {
    return false; // soft exhaustion
  }
  execFileSync(args.hdc, ['shell', 'uitest', 'uiInput', 'click',
    String(at.x), String(at.y)]);
  console.log(`drive: tapped ${what} at ${at.x},${at.y}`);
  return true;
};

const snapshot = (file) => {
  if (!file) {
    return;
  }
  try {
    shell(`snapshot_display -f /data/local/tmp/dsh-drive-shot.jpeg`);
    hdcHere(['file', 'recv', '/data/local/tmp/dsh-drive-shot.jpeg', file]);
    console.log(`drive: screenshot -> ${file}`);
  } catch (e) {
    console.error(`drive: snapshot failed (non-fatal): ${e.message}`);
  }
};

// ---- the event loop ---------------------------------------------------------

const state = {
  permissionWait: false,
  approvalWait: false,
  notifyScheduled: false,
  backgrounded: false,
  liveShot: false,
  verdict: null,
};

const onLine = async (line) => {
  if (state.verdict !== null) {
    return;
  }
  if (line.includes('ui-wait notification-permission')) {
    state.permissionWait = true;
  }
  if (state.permissionWait && !state.permissionDone &&
      (line.includes('ui-done notification-permission'))) {
    state.permissionDone = true;
  }
  if (line.includes('ui-wait approval')) {
    state.approvalWait = true;
  }
  if (line.includes('ui-done notify-scheduled')) {
    state.notifyScheduled = true;
  }
  if (line.includes('"event":"app.state","state":"background"')) {
    state.backgrounded = true;
  }
  if (line.includes('"event":"ws.token-delta"') && !state.liveShot) {
    state.liveShot = true;
    snapshot(args['shot-live']);
  }
  if (line.includes('dsh.spike.verdict: m5.host-binding')) {
    state.verdict = line.includes(' PASS ') ? 'pass' : 'fail';
  }
};

const act = async () => {
  if (state.permissionWait && !state.permissionTapTried) {
    // The consent dialog races the grant; poll briefly, then move on — the
    // ui-done marker (or publish failure) is the authoritative outcome.
    // EXACT text match: the zh dialog's title CONTAINS '允许' — a contains
    // match once tapped the title instead of the button (observed on-device).
    // SOFT: a granted install (data persists across `hdc install -r`) never
    // shows the dialog, and that is the happy path, not a failure.
    state.permissionTapTried = true;
    tapText('notification permission Allow', /^(Allow|允许)$/, 20_000, true)
      .then((tapped) => {
        if (!tapped) {
          console.log('drive: no permission dialog (already granted)');
        }
      });
  }
  if (state.approvalWait && !state.approvalTapped) {
    state.approvalTapped = true;
    await tapText('approval Approve', /^Approve$/, STEP);
  }
  if (state.notifyScheduled && !state.notifyHandled) {
    state.notifyHandled = true;
    execFileSync(args.hdc, ['shell', 'uitest', 'uiInput', 'keyEvent', 'Home']);
    console.log('drive: pressed Home (background edge)');
  }
  if (state.notifyHandled && state.backgrounded && !state.shadeOpened) {
    state.shadeOpened = true;
    execFileSync(args.hdc,
      ['shell', 'uitest', 'uiInput', 'swipe', '360', '30', '360', '1800', '600']);
    console.log('drive: opened the notification shade');
    await pollUntil('app.state background edge', async () => state.backgrounded, STEP);
    await tapText('DSH notification', /DSH E2E/, STEP);
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
    onLine(line).catch((e) => die(`line handler: ${e.message}`));
  }
});
stream.on('exit', () => die('hilog stream ended early'));

pollUntil('m5.host-binding verdict', async () => {
  await act();
  return state.verdict;
}, OVERALL).then((verdict) => {
  stream.kill();
  snapshot(args['shot-final']);
  if (verdict !== 'pass') {
    die(`verdict ${verdict}`);
  }
  console.log('drive: PASS (m5.host-binding verdict on the log stream)');
  process.exit(0);
}).catch((e) => die(e.message));
