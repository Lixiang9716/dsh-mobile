#!/usr/bin/env node
// dsh:logging-exempt (E2E UI-automation driver: a dev script whose console
// output IS the drive evidence — same standing as test/e2e/check.mjs)
/**
 * drive-mic-plane.mjs — UI-automation driver for the harmony.mic-plane leg
 * (the capability plane's microphone face, v1.10.0 candidate) on the local
 * HarmonyOS emulator. Sibling of drive-device-plane.mjs: tails the runner's
 * hilog stream file and drives the surface the scenario blocks on:
 *
 *   ui-wait microphone-permission → tap the system permission dialog's
 *                                    allow button (SOFT: a pre-granted
 *                                    install has no dialog)
 *   dsh.dsh.verdict: harmony.mic-plane → done (exit 0 on PASS)
 *
 * usage: drive-mic-plane.mjs --hdc <path> --stream <file>
 *                            [--overall-deadline S] [--shot-final PNG]
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const usage = () => {
  console.error('usage: drive-mic-plane.mjs --hdc <path> --stream <file>' +
    ' [--overall-deadline S] [--shot-final PNG]');
  process.exit(2);
};

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) usage();
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!args.hdc || !args.stream) usage();

const OVERALL = Number(args['overall-deadline'] ?? 300) * 1000;
const STEP = 30_000;
const startedAt = Date.now();
const work = mkdtempSync(join(tmpdir(), 'dsh-mp-drive-'));

const die = (msg) => {
  console.error(`drive-mp: FAIL ${msg}`);
  process.exit(1);
};
const shell = (cmd) => execFileSync(args.hdc, ['shell', cmd], { encoding: 'utf8' }).trim();

const tapText = async (what, regex, ms, soft = false) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (Date.now() - startedAt > OVERALL) die('overall deadline');
    let layout = '';
    try {
      shell('uitest dumpLayout -p /data/local/tmp/dsh-mp-layout.json');
      execFileSync(args.hdc, ['file', 'recv', '/data/local/tmp/dsh-mp-layout.json',
        `${work}/layout.json`], { encoding: 'utf8' });
      layout = readFileSync(`${work}/layout.json`, 'utf8');
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const hit = findText(JSON.parse(layout), regex);
    if (hit) {
      shell(`uitest uiInput click ${hit.x} ${hit.y}`);
      console.log(`drive-mp: tapped ${what} at (${hit.x},${hit.y})`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!soft) console.log(`drive-mp: ${what} never appeared`);
  return false;
};

/** Innermost node whose text or content matches, from the uitest dump. */
const findText = (node, regex) => {
  const walk = (n) => {
    if (n === null || typeof n !== 'object') return null;
    const attrs = n.attributes ?? n;
    const text = `${attrs.text ?? ''} ${attrs['content-desc'] ?? ''}`.trim();
    if (regex.test(text)) {
      const b = attrs.bounds ?? '';
      const m = b.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (m) {
        const cx = Math.round((Number(m[1]) + Number(m[3])) / 2);
        const cy = Math.round((Number(m[2]) + Number(m[4])) / 2);
        return { x: cx, y: cy };
      }
    }
    for (const child of n.children ?? []) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(node);
};

const state = { permission: 0, verdict: null };

const onLine = (line) => {
  if (state.verdict !== null) return;
  if (line.includes('ui-wait microphone-permission')) {
    state.permission += 1;
    const n = state.permission;
    tapText(`microphone allow #${n}`,
      /^(允许|Allow|仅本次允许|Always allow)$/, STEP, true)
      .then((t) => {
        if (!t) console.log('drive-mp: no permission dialog (pre-granted or auto-granted)');
      });
  }
  if (line.includes('dsh.dsh.verdict: harmony.mic-plane')) {
    state.verdict = line.includes(' PASS ') ? 'pass' : 'fail';
  }
};

// -n +1: the FULL file first (the marker sits early in the run; the
// default tail -F only prints the last 10 lines and races past it)
const tail = spawn('tail', ['-n', '+1', '-F', args.stream], { stdio: ['ignore', 'pipe', 'ignore'] });
const rl = createInterface({ input: tail.stdout });
for await (const line of rl) {
  onLine(line);
  if (state.verdict !== null) break;
  if (Date.now() - startedAt > OVERALL) {
    tail.kill('SIGKILL');
    die('overall deadline before the verdict line');
  }
}
tail.kill('SIGKILL');
if (args['shot-final']) {
  shell('snapshot_display -f /data/local/tmp/dsh-mp-final.jpeg >/dev/null 2>&1 || true');
  try {
    execFileSync(args.hdc, ['file', 'recv', '/data/local/tmp/dsh-mp-final.jpeg',
      args['shot-final']], { encoding: 'utf8' });
  } catch { /* the shot is evidence, never the verdict */ }
}
if (state.verdict === null) die('the verdict line never arrived');
console.log(`drive-mp: verdict ${state.verdict}`);
process.exit(state.verdict === 'pass' ? 0 : 1);
