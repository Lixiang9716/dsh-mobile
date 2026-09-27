#!/usr/bin/env node
// dsh:logging-exempt (E2E UI-automation driver: a dev script whose console
// output IS the drive evidence — same standing as test/e2e/check.mjs)
/**
 * drive-device-plane.mjs — UI-automation driver for the harmony.device-plane
 * leg (contract v1.5.0) on the local HarmonyOS emulator. Sibling of
 * drive-binding.mjs: tails the hilog stream and drives the surfaces the
 * scenario blocks on:
 *
 *   ui-wait clipboard-read → tap the custom approval dialog's Approve
 *                            (the dialog has no remember button on this
 *                            host, so ALL THREE reads tap Approve)
 *   ui-wait share          → BACK (the emulator image's share chooser has
 *                            no deterministic completion target; the user
 *                            walking away resolves {shared:false} — a value)
 *   ui-wait picker media   → BACK (the media leg drives cancellation; the
 *                            emulator image's gallery is not seedable)
 *   dsh.spike.verdict: harmony.device-plane → done (exit 0 on PASS)
 *
 * usage: drive-device-plane.mjs --hdc <path> [--overall-deadline S]
 *                               [--shot-final PNG]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const usage = () => {
  console.error('usage: drive-device-plane.mjs --hdc <path> [--overall-deadline S]' +
    ' [--shot-final PNG]');
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
const startedAt = Date.now();
const work = mkdtempSync(join(tmpdir(), 'dsh-dp-drive-'));

const die = (msg) => {
  console.error(`drive-dp: FAIL ${msg}`);
  process.exit(1);
};
const shell = (cmd) => execFileSync(args.hdc, ['shell', cmd], { encoding: 'utf8' }).trim();

const tapText = async (what, regex, ms, soft = false) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (Date.now() - startedAt > OVERALL) die('overall deadline');
    let layout = '';
    try {
      shell(`uitest dumpLayout -p /data/local/tmp/dsh-dp-layout.json`);
      layout = execFileSync(args.hdc, ['file', 'recv', '/data/local/tmp/dsh-dp-layout.json',
        `${work}/layout.json`], { encoding: 'utf8' });
      layout = (await import('node:fs')).readFileSync(`${work}/layout.json`, 'utf8');
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const hit = findText(JSON.parse(layout), regex);
    if (hit) {
      shell(`uitest uiInput click ${hit.x} ${hit.y}`);
      console.log(`drive-dp: tapped ${what} at (${hit.x},${hit.y})`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (soft) return false;
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

/** True when the CURRENT layout carries a node matching REGEX (polled a
 * few seconds — surfaces present late). */
const layoutMatches = async (regex) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      shell('uitest dumpLayout -p /data/local/tmp/dsh-dp-layout.json');
      execFileSync(args.hdc, ['file', 'recv', '/data/local/tmp/dsh-dp-layout.json',
        `${work}/layout.json`], { encoding: 'utf8' });
      const tree = JSON.parse(readFileSync(`${work}/layout.json`, 'utf8'));
      if (findText(tree, regex)) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const state = { clipboardReads: 0, shares: 0, pickers: 0, verdict: null };

const onLine = async (line) => {
  if (state.verdict !== null) return;
  if (line.includes('ui-wait clipboard-read')) {
    state.clipboardReads += 1;
    const n = state.clipboardReads;
    tapText(`clipboard approve #${n}`, /^Approve$/, STEP)
      .then((t) => {
        if (!t) console.log('drive-dp: approve button never appeared');
        // the system READ_PASTEBOARD dialog follows our approval gate —
        // tap its allow button too (SOFT: a pre-granted install has none)
        return tapText(`system permission allow #${n}`,
          /^(允许|Allow|仅本次允许|Always allow)$/, 15_000, true);
      })
      .then((t) => { if (!t) console.log('drive-dp: no system permission dialog (granted)'); });
  }
  if (line.includes('ui-wait share')) {
    state.shares += 1;
    const n = state.shares;
    setTimeout(async () => {
      // BACK only when a share surface is ACTUALLY up: a blind BACK with no
      // chooser on screen exits the app (backgrounded timers freeze — the
      // in-app guard then never fires, measured 2026-09-26).
      if (await layoutMatches(/(分享|share|Share|发送到|选择)/)) {
        shell('uitest uiInput keyEvent Back');
        console.log(`drive-dp: share #${n} -> BACK (walking away)`);
      } else {
        console.log(`drive-dp: share #${n} -> no surface (in-app guard settles it)`);
      }
    }, 2500);
  }
  if (line.includes('ui-wait picker media')) {
    state.pickers += 1;
    const n = state.pickers;
    setTimeout(async () => {
      // same discipline: only dismiss a picker page that is actually up
      if (await layoutMatches(/(照片|图片|图库|Gallery|Photos|选择)/)) {
        shell('uitest uiInput keyEvent Back');
        console.log(`drive-dp: media picker #${n} -> BACK (dismissal is a value)`);
      } else {
        console.log(`drive-dp: media picker #${n} -> no page (in-app guard settles it)`);
      }
    }, 2500);
  }
  if (line.includes('dsh.spike.verdict: harmony.device-plane')) {
    state.verdict = line.includes(' PASS ') ? 'pass' : 'fail';
  }
};

// Tail the RUNNER's hilog stream FILE (--stream): spawning our own
// `hdc shell hilog` here would attach AFTER the app started and miss the
// first markers (measured 2026-09-26 — the scenario reaches its first
// dialog within ~1s of aa start). The runner owns the capture; the drive
// tails the same file (tail -F semantics, line-streamed).
import { createInterface } from 'node:readline';

const { spawn } = await import('node:child_process');
if (!args.stream) {
  console.error('drive-dp: --stream <file> is required (the runner hilog capture)');
  process.exit(2);
}
// -n +1: the FULL file first (the marker sits early in the run; the
// default tail -F only prints the last 10 lines and races past it)
const tail = spawn('tail', ['-n', '+1', '-F', args.stream], { stdio: ['ignore', 'pipe', 'ignore'] });
const rl = createInterface({ input: tail.stdout });
for await (const line of rl) {
  await onLine(line);
  if (state.verdict !== null) break;
  if (Date.now() - startedAt > OVERALL) {
    tail.kill('SIGKILL');
    die('overall deadline before the verdict line');
  }
}
tail.kill('SIGKILL');
if (args['shot-final']) {
  shell(`snapshot_display -f /data/local/tmp/dsh-dp-final.jpeg >/dev/null 2>&1 || true`);
  try {
    execFileSync(args.hdc, ['file', 'recv', '/data/local/tmp/dsh-dp-final.jpeg',
      args['shot-final']], { encoding: 'utf8' });
  } catch { /* the shot is evidence, never the verdict */ }
}
if (state.verdict === null) die('the verdict line never arrived');
console.log(`drive-dp: verdict ${state.verdict}`);
process.exit(state.verdict === 'pass' ? 0 : 1);
