#!/usr/bin/env node
// dsh:logging-exempt (dev script: console IS the product, like check-staging.mjs)
/**
 * check-transport-tokens.mjs — the transport-tokens gate.
 *
 * runtime/dsh/transport-tokens.mjs is the single source of truth for the
 * cross-layer transport/E2E token strings (log-line prefix, verdict marker,
 * tag family, manifest identity). This checker holds the whole tree to it
 * with two assertions:
 *
 *   (a) NO pre-rename spelling survives anywhere in the product surfaces:
 *       dsh.spike. / dsh.rt. / dsh.dsh. / com.dshmobile.spike /
 *       m1.spike / m2.spike — the exact four-incident drift class the
 *       2026-10 rename post-mortem recorded (dsh.rt.verdict vs
 *       dsh.dsh.verdict vs dsh.runtime.verdict; dsh.rt.result;
 *       dsh.dsh.scenario). One hit = exit 1 with the file:line named.
 *
 *   (b) every token is still SPELLED by every layer that consumes it — a
 *       grep count per (token × consuming layer); a layer whose count drops
 *       to 0 has either renamed its literal (drift) or stopped consuming
 *       the token (the layer map below needs a conscious update, with a
 *       commit explaining why). This is what makes "defined but unused,
 *       while a fresh literal appears" impossible: the canonical JS layers
 *       import the table, and the non-JS layers are pinned by THIS count.
 *
 * DESIGN NOTE — why C/ArkTS/Kotlin/Swift keep literals (no codegen): the C
 * sink (dsh_runtime_host.c) must stay a freestanding translation unit every
 * platform build compiles directly; the emitters are not JS-module
 * environments, so "importing" the table would mean a per-platform
 * generator plus a build-order dependency three build systems do not
 * share. The defect class here is SPELLING DRIFT, and a presence count
 * catches it exactly as well without coupling the builds. The canonical JS
 * closure imports the table; every other layer answers to assertion (b).
 *
 * Scan set: git-TRACKED files only (the stagers' untracked vendored bytes
 * are third-party upstream discipline, D6, and never a spelling surface for
 * this repo's conventions). Excluded trees, each with its reason:
 *   - artifacts/ (any path segment) — committed E2E evidence captures; the
 *     bytes record what past runs emitted, renaming them would forge
 *     history.
 *   - .agents/notes/, .gov/tasks/, .gov/surprises.jsonl, docs/e2e-matrix.md
 *     (+ .zh.md) — historical governance assets; the 2026-10 rename
 *     decision (owner ruling) keeps old spellings in them: decision
 *     addresses are not renumbered.
 *   - .gov/rejections/case-transport-tokens.sh — this gate's own rejection
 *     case carries the forbidden literal it injects; scanning it would make
 *     the proof self-tripping.
 *   - aoci* / .aoci/ / .zcode/ / node_modules/ / hosts/ios/App/Generated/ /
 *     test/e2e/fixtures — cognition layers, agent scratch, third-party
 *     trees, machine-generated C, and hand-written synthetic fixtures that
 *     intentionally exercise spellings.
 *
 * usage: node tools/check-transport-tokens.mjs   exit 0 = clean, 1 = drift
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TRANSPORT_TOKENS } from '../runtime/dsh/transport-tokens.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- the scan set ------------------------------------------------------------

/** Historical/foreign trees (see header). A hit inside them is repo-decided
 * retention, not drift — but the list is explicit so a NEW exclusion is
 * always a reviewed diff, never silent. */
const EXCLUDE = [
  (p) => p.split('/').includes('artifacts'),
  (p) => p.startsWith('.agents/'),
  (p) => p.startsWith('.gov/tasks/'),
  (p) => p === '.gov/surprises.jsonl',
  (p) => p === '.gov/rejections/case-transport-tokens.sh',
  // The checker itself owns the forbidden list — its literals ARE the ban
  // (the same self-reference carve-out the rejection case gets). Measured
  // the hard way: the moment this file became git-tracked, assertion (a)
  // flagged its own FORBIDDEN array — the scan set is tracked files, so a
  // new checker must exempt itself in the same commit it lands.
  (p) => p === 'tools/check-transport-tokens.mjs',
  (p) => p.startsWith('.aoci/'),
  (p) => p.startsWith('.zcode/'),
  (p) => p.startsWith('node_modules/'),
  (p) => p.startsWith('hosts/ios/App/Generated/'),
  (p) => p.startsWith('test/e2e/fixtures/'),
  (p) => p.startsWith('docs/e2e-matrix.md') || p === 'docs/e2e-matrix.zh.md',
  (p) => (p.split('/').pop() || '').startsWith('aoci'),
];

const tracked = () =>
  execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { maxBuffer: 1 << 26 })
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0 && !EXCLUDE.some((f) => f(p)));

/** Binary sniff: a NUL in the first 8 KiB means bytes, not spelling. */
const isText = (buf) => !buf.subarray(0, 8192).includes(0);

// --- assertion (a): no pre-rename spelling -----------------------------------

/** The forbidden family — every spelling the rename retired. `dsh.rt.` and
 * `dsh.dsh.` are the intermediate split-brain spellings the post-mortem
 * found coexisting with the canonical one; they are banned with the same
 * force as the pre-rename names. */
const FORBIDDEN = [
  'dsh.spike.',
  'dsh.rt.',
  'dsh.dsh.',
  'com.dshmobile.spike',
  'm1.spike',
  'm2.spike',
];

const forbiddenHits = (files) => {
  const hits = [];
  for (const rel of files) {
    let buf;
    try {
      buf = readFileSync(join(REPO, rel));
    } catch {
      continue; // tracked but removed in the working tree — git's own red
    }
    if (!isText(buf)) continue;
    const src = buf.toString('utf8');
    for (const bad of FORBIDDEN) {
      const at = src.indexOf(bad);
      if (at >= 0) {
        const line = src.slice(0, at).split('\n').length;
        hits.push({ rel, line, token: bad });
      }
    }
  }
  return hits;
};

// --- assertion (b): every token still spelled by every consuming layer -------

/** A consuming layer = tracked files under `under` with one of `ext`
 * (minus `skip` subtrees). The map mirrors how the layers actually consume
 * TODAY — keep it in lockstep with reality, citing the primary consumer in
 * the token map below. */
const LAYERS = {
  'c-host-glue': {
    under: ['runtime/dsh/host/', 'hosts/android/app/src/main/cpp/', 'hosts/harmony/entry/src/main/cpp/'],
    ext: ['.c', '.h', '.cpp', '.ts'],
    why: 'the shared C sink + the JNI/NAPI glue that emit to logcat/hilog',
  },
  kotlin: {
    under: ['hosts/android/app/src/main/java/'],
    ext: ['.kt'],
    why: 'the Android emitters (gateway core, session hosts, carrier)',
  },
  arkts: {
    under: ['hosts/harmony/entry/src/main/ets/'],
    ext: ['.ets'],
    why: 'the HarmonyOS emitters (phases, serve surfaces)',
  },
  swift: {
    under: ['hosts/ios/App/Source/'],
    ext: ['.swift'],
    why: 'the iOS emitters (runtimes, gateway core)',
  },
  'node-driver': {
    under: ['hosts/android/ci/', 'hosts/harmony/ci/', 'hosts/ios/ci/'],
    ext: ['.mjs'],
    why: 'the on-device E2E drivers that parse the streams',
  },
  'shell-runner': {
    under: ['hosts/android/ci/', 'hosts/harmony/ci/', 'hosts/ios/ci/', 'runtime/dsh/ci/', 'test/', 'build/'],
    ext: ['.sh'],
    why: 'the shell runners that grep the streams and drive adb/hdc',
  },
  'canonical-js': {
    under: ['runtime/dsh/'],
    ext: ['.js', '.mjs'],
    skip: ['runtime/dsh/vendor/', 'runtime/dsh/transport-tokens.mjs'],
    why: 'the canonical closure (imports the table; mirrors are byte-copies)',
  },
  'canonical-manifest': {
    files: ['runtime/dsh/manifest.json'],
    why: "the caller manifest — the gateway permission record's id",
  },
  'ci-config': {
    files: ['hosts/android/app/build.gradle.kts', 'hosts/android/app/src/main/AndroidManifest.xml'],
    under: ['.github/workflows/'],
    ext: ['.yml'],
    why: 'the app id declarations (gradle/manifest) and the CI workflows',
  },
};

/** token → the layers that must spell it ≥1 time. Primary consumer cited
 * per layer so a red names something greppable, not an abstraction. */
const TOKEN_LAYERS = {
  logLinePrefix: {
    'c-host-glue': 'dsh_runtime_host.c DSH_LOG_PREFIX',
    kotlin: 'BindingHost/GatewayCore/CarrierEventLog sink forwarding',
    arkts: 'HostPhase/OfficialPhase/OfficialServe phase sink',
    swift: 'JsRuntime/SessionRuntime/CRuntimeFactory sink forwarding',
    'shell-runner': "every runner's grep '^dsh.runtime.log:'",
  },
  verdictMarker: {
    'c-host-glue': 'napi_init.cpp hilog verdict line',
    arkts: 'HostPhase/OfficialPhase/V2WebPhase/Index verdict matchers',
    'node-driver': 'hosts/harmony/ci/drive-*.mjs verdict awaits',
    'shell-runner': "runners' grep 'dsh.runtime.verdict:'",
  },
  logcatTag: {
    'c-host-glue': 'JNI/NAPI TAG defines (dsh_jni_*.c, napi_init.cpp)',
    kotlin: 'TAG constants (BindingHost et al.)',
    'shell-runner': "logcat/hilog filters (-s dsh.runtime, grep 'dsh.runtime')",
  },
  resultTag: {
    'c-host-glue': 'dsh_jni_scenario.c result tag emit',
    kotlin: 'the *Session.kt gateway result emits',
    arkts: 'V2WebPhase result stream',
    'shell-runner': "runners' dsh.runtime.result counting",
  },
  auditTag: {
    kotlin: 'GatewayCore.kt audit stream tag',
    'shell-runner': "runners' dsh.runtime.audit counting",
  },
  uiTag: {
    kotlin: 'GatewayCore.kt ui stream tag',
    'shell-runner': "runners' dsh.runtime.ui counting",
  },
  auditLinePrefix: {
    kotlin: 'GatewayCore.kt AUDIT_PREFIX',
    arkts: 'HostPhase.ets hostCarrierLine audit prefix',
    swift: 'GatewayCore.swift auditPrefix',
    'shell-runner': "runners' grep 'dsh.gateway.audit'",
  },
  scenarioModule: {
    'canonical-js': "scenario/*.js createLogger(scenarioModule)",
  },
  appId: {
    kotlin: 'package declarations + application id reads',
    'ci-config': 'gradle applicationId / workflows adb targets',
    'shell-runner': "runners' adb am start -n com.dshmobile.host/…",
  },
  callerId: {
    'canonical-manifest': "manifest.json id — the gateway caller identity",
    kotlin: 'GatewayCore.kt manifest caller id',
    arkts: 'HostPhase.ets manifest caller id',
    swift: 'GatewayCore.swift manifest caller id',
    'shell-runner': 'stage-spine-closure.sh manifest byte-sync comment',
  },
};

const layerFiles = (layer) => {
  const def = LAYERS[layer];
  const set = new Set(def.files || []);
  for (const rel of ALL) {
    if (def.under && !def.under.some((u) => rel.startsWith(u))) continue;
    if (def.skip && def.skip.some((s) => rel === s || rel.startsWith(s + '/'))) continue;
    if (def.ext && !def.ext.some((e) => rel.endsWith(e))) continue;
    set.add(rel);
  }
  return [...set];
};

/** logcatTag is a strict PREFIX of the other tokens, so a plain substring
 * count is satisfied vacuously; it is counted standalone (next char is
 * neither word nor dot) — the TAG/filter spellings. Trailing space is
 * trimmed before counting (auditLinePrefix's space is emitter formatting;
 * the shell greps key on the marker sans space, and the marker is the
 * shared contract). */
const STANDALONE = new Set(['logcatTag']);
const countToken = (src, key) => {
  const tok = TRANSPORT_TOKENS[key].replace(/ +$/, '');
  if (!STANDALONE.has(key)) {
    let n = 0;
    let at = src.indexOf(tok);
    while (at >= 0) {
      n += 1;
      at = src.indexOf(tok, at + tok.length);
    }
    return n;
  }
  const re = new RegExp(
    tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w.])',
    'g',
  );
  return [...src.matchAll(re)].length;
};

// --- run ---------------------------------------------------------------------

const ALL = tracked();

// (a)
const hits = forbiddenHits(ALL);
if (hits.length > 0) {
  console.error(
    `check-transport-tokens: FAIL — ${hits.length} pre-rename token hit(s)`
    + ' (canonical spellings live in runtime/dsh/transport-tokens.mjs):',
  );
  for (const h of hits) {
    console.error(`  ${h.rel}:${h.line}: '${h.token}'`);
  }
  process.exit(1);
}

// (b)
const misses = [];
const layerCache = new Map();
for (const [key, layers] of Object.entries(TOKEN_LAYERS)) {
  for (const [layer, where] of Object.entries(layers)) {
    if (!layerCache.has(layer)) layerCache.set(layer, layerFiles(layer));
    let count = 0;
    let named = '';
    for (const rel of layerCache.get(layer)) {
      let buf;
      try {
        buf = readFileSync(join(REPO, rel));
      } catch {
        continue;
      }
      if (!isText(buf)) continue;
      const n = countToken(buf.toString('utf8'), key);
      if (n > 0) {
        count += n;
        if (!named) named = rel;
      }
    }
    if (count === 0) {
      misses.push(`token '${key}' absent from layer '${layer}' (${where})`
        + ` — renamed literal (drift) or the layer map needs a conscious update`);
    }
  }
}
if (misses.length > 0) {
  console.error(
    `check-transport-tokens: FAIL — ${misses.length} token×layer presence miss(es):`,
  );
  for (const m of misses) {
    console.error(`  ${m}`);
  }
  process.exit(1);
}

const tokenCount = Object.keys(TOKEN_LAYERS).length;
const layerChecks = Object.values(TOKEN_LAYERS)
  .reduce((n, layers) => n + Object.keys(layers).length, 0);
console.log(
  `check-transport-tokens: OK (${ALL.length} tracked files scanned,`
  + ` 0 old spellings, ${tokenCount} tokens × ${layerChecks} layer checks present)`,
);
