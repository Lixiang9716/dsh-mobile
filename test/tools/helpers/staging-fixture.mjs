// Fixture repo builder for the staging-tool tests.
//
// check-staging.mjs and gen-staging-manifests.mjs resolve the repo root from
// their own import.meta.url, so the way to run them against a synthetic tree
// is to copy the real tool sources VERBATIM into a tmp dir laid out as a repo
// and surround them with minimal, parser-compatible manifests. Every test
// mutation (a staging gap, a stale row, a twin drift) is then a tmp-only edit
// — no repo file is ever touched.
//
// The manifest shapes below are reduced but syntactically true to the real
// ones the parsers walk: Index.ets BUNDLE_FILES (multiline `const … = [` …
// `\n];`), vendor-official.sh (multiline double-quoted CLOSURE accumulation +
// $() find spans + simple-var interpolation), stage-spine-closure.sh (six
// for-in lists: scenario/dsh/npm × stage/verify + the mirror needles),
// gen_bundle_header.py (RESOURCES with prose comments, TREES with a
// comprehension + `] + [` continuation, ZOD_FILES).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOL_FILES = [
  'check-staging.mjs', 'check-staging-graph.mjs', 'check-staging-hosts.mjs',
  'gen-staging-manifests.mjs', 'gen-staging-legs.mjs',
];
export const VER = '0.1.6-alpha.2';
export const ZOD_PIN = 'vendor/npm/zod@4.4.3';

// --- the spike closure (import graph the walker must traverse) --------------

const SPIKE_FILES = {
  'logger.js': 'export const log = () => {};\n',
  'upstream/boot.js': "import './web-boot.js';\n",
  'upstream/web-boot.js': [
    "import '../scenario/upstream-suite-leg.js';",
    "import '../system-plugins/dsh-fs/manifest.json';",
    "import '/vendor/npm/pin@1.0.0/lib/index.js';",
    '',
  ].join('\n'),
  'scenario/upstream-suite-leg.js': "import './leg-a.js';\nimport '../upstream/helper.js';\n",
  'scenario/leg-a.js': "export { a } from '../upstream/helper.js';\n",
  'upstream/helper.js': "import './extra.js';\n",
  'upstream/extra.js': 'export const a = 1;\n',
  'system-plugins/dsh-fs/manifest.json': '{}\n',
  'system-plugins/dsh-fs/lib/plugin.js': 'export const p = 1;\n',
  'vendor/npm/pin@1.0.0/lib/index.js': "import './dep.js';\n",
  'vendor/npm/pin@1.0.0/lib/dep.js': 'export const d = 1;\n',
};

// The files walkGraph reaches from the boot entries, in scope
// (scenario/ upstream/ system-plugins/) — exactly what check (a) judges.
export const SCOPED_REACHED = [
  'scenario/leg-a.js', 'scenario/upstream-suite-leg.js',
  'system-plugins/dsh-fs/manifest.json',
  'upstream/boot.js', 'upstream/extra.js', 'upstream/helper.js',
  'upstream/web-boot.js',
].sort();

export const ZOD_ROWS = [
  `${ZOD_PIN}/errors.js`, `${ZOD_PIN}/index.js`, `${ZOD_PIN}/v4/classic/checks.js`,
].sort();

const WEBCLIENT_TREES = [
  { dir: 'presentation/web-client', staged: 'dsh-web-client' },
  { dir: 'presentation/web-client-next', staged: 'dsh-web-client-next' },
  { dir: 'presentation/web-client-whale', staged: 'dsh-web-client-whale' },
];

// Every row the generator derives on the green fixture: graph + dshpins +
// pinfiles (noble js, pi-ai js+json, goal trio, zod closure) + closure-faces
// (the vendor rows CLOSURE carries) + webclient. Index.ets commits exactly
// this set, so set parity holds with zero extras.
export function derivedBundleRows() {
  return [
    ...SCOPED_REACHED,
    'vendor/npm/pin@1.0.0/lib/index.js',
    `vendor/dsh/agent@${VER}/package.json`, `vendor/dsh/agent@${VER}/lib/index.js`,
    `vendor/dsh/brand@${VER}/package.json`, `vendor/dsh/brand@${VER}/lib/index.js`,
    'vendor/npm/@noble/hashes@2.3.0/lib/index.js',
    'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/index.js',
    'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/index.json',
    ...ZOD_ROWS,
    'vendor/npm/cordis@4.0.2/package.json',
    ...WEBCLIENT_TREES.map((t) => `webclient/${t.staged}/index.html`),
  ].sort();
}

// --- manifest builders -------------------------------------------------------

/** vendor-official.sh: CLOSURE accumulates (base group + $SPINE_OURS group),
 * interpolates $PIN, and carries a $(find … | LC_ALL=C sort) span whose pin
 * CHOICE the generator reads (goalTrio). The zod rows ride as plain rows —
 * the $() span is stripped from the row list by design. */
function vendorOfficialSh() {
  const rows = [
    ...SCOPED_REACHED,
    'vendor/npm/@noble/hashes@2.3.0/lib/index.js',
    'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/index.js',
    `vendor/dsh/agent@$PIN/package.json`,
    `vendor/dsh/brand@$PIN/package.json`,
    ...ZOD_ROWS,
    'vendor/npm/cordis@4.0.2/package.json',
  ];
  return [
    '#!/bin/sh',
    '# fixture: minimal shape-compatible vendor-official.sh',
    'NOBLE_DIR="vendor/npm/@noble/hashes@2.3.0"',
    'PIAI_DIR="vendor/npm/@earendil-works/pi-ai@0.85.1"',
    'SPINE_PKG_DSH="agent brand"',
    'PIN=0.1.6-alpha.2',
    `CLOSURE="${rows.join('\n')}`,
    `$(cd runtime/spike && find ${ZOD_PIN} -name '*.js' | LC_ALL=C sort)`,
    '"',
    'SPINE_OURS="$SPINE_OURS',
    'vendor/npm/cordis@4.0.2/package.json',
    '"',
    'CLOSURE="$CLOSURE',
    '$SPINE_OURS"',
    '',
  ].join('\n');
}

/** Index.ets: the bundle materialization list (rows are single-quoted). */
function indexEts(rows) {
  return [
    'import { common } from "@kit.AbilityKit";',
    'const BUNDLE_FILES: string[] = [',
    ...rows.map((r) => `  '${r}',`),
    '];',
    '@Entry struct Index {}',
    '',
  ].join('\n');
}

/** stage-spine-closure.sh: SIX for-in lists (scenario/dsh/npm × stage/verify
 * twins — the generator refuses any other count) + the three whole-dir
 * mirror needles the verifier requires + VER/ZOD_SRC. */
function stageSpineClosureSh() {
  const scenario = 'leg-a.js upstream-suite-leg.js';
  const dsh = 'agent brand';
  const npm = 'dsh-anonymous dsh-goalish';
  return [
    '#!/bin/sh',
    '# fixture: minimal shape-compatible stage-spine-closure.sh',
    `VER=${VER}`,
    `ZOD_SRC=$SPIKE/${ZOD_PIN}`,
    'for pkg in ' + dsh + '; do',
    `    stage_pkg "$SPIKE/vendor/dsh/$pkg@$VER" "$ASSETS/vendor/dsh/$pkg@$VER"`,
    'done',
    'for pkg in ' + npm + '; do',
    `    stage_pkg "$SPIKE/vendor/npm/@deepseek-ai/$pkg@$VER" "$ASSETS/vendor/npm/@deepseek-ai/$pkg@$VER"`,
    'done',
    'for s in ' + scenario + '; do',
    '        cp "$SPIKE/scenario/$s" "$ASSETS/scenario/$s"',
    'done',
    'find "$SPIKE/upstream" -maxdepth 1 -name \'*.js\' -type f | while IFS= read -r src; do',
    '    cp "$src" "$ASSETS/upstream/$(basename "$src")"',
    'done',
    'find "$SPIKE/upstream/shims" -name \'*.js\' -type f | while IFS= read -r src; do',
    '    cp "$src" "$ASSETS/upstream/shims/$(basename "$src")"',
    'done',
    'for src in "$SPIKE"/system-plugins/*/; do',
    '    cp -r "$src" "$ASSETS/system-plugins/$(basename "$src")"',
    'done',
    '# verify twins',
    'for pkg in ' + dsh + '; do test -d "$ASSETS/vendor/dsh/$pkg@$VER"; done',
    'for pkg in ' + npm + '; do test -d "$ASSETS/vendor/npm/@deepseek-ai/$pkg@$VER"; done',
    'for s in ' + scenario + '; do test -f "$ASSETS/scenario/$s"; done',
    '',
  ].join('\n');
}

/** gen_bundle_header.py: RESOURCES (SPIKE- and REPO-rooted rows, prose
 * comments with apostrophes/quotes/parens), TREES (comprehension + `] + [`
 * continuation + plain rows), ZOD_FILES (the third hand zod copy). */
function genBundleHeaderPy() {
  return [
    'import pathlib',
    'REPO = pathlib.Path(__file__).resolve().parents[2]',
    'SPIKE = REPO / "runtime" / "spike"',
    'RESOURCES = [',
    '    ("logger_js", SPIKE / "logger.js"),',
    `    # prose with an apostrophe: the loader's note; "quoted" and (parens)`,
    '    # stay comment prose — the scanner must skip them whole.',
    '    ("leg_a_js", SPIKE / "scenario" / "leg-a.js"),',
    '    ("suite_leg_js", SPIKE / "scenario" / "upstream-suite-leg.js"),',
    '    ("webclient_src", REPO / "presentation" / "web-client" / "index.html"),',
    ']',
    '',
    'TREES = [',
    '    (f"vendor/dsh/{pkg}@' + VER + '",',
    `     SPIKE / "vendor" / "dsh" / f"{pkg}@${VER}")`,
    '    for pkg in [',
    '        "agent", "brand",',
    '    ]',
    '] + [',
    '    ("scenario", SPIKE / "scenario"),',
    '    ("upstream", SPIKE / "upstream"),',
    '    ("system-plugins", SPIKE / "system-plugins"),',
    '    ("webclient/dsh-web-client", REPO / "presentation" / "web-client"),',
    ']',
    '',
    'ZOD_FILES = [',
    '    "index.js",',
    '    "errors.js",',
    '    "v4/classic/checks.js",',
    ']',
    '',
  ].join('\n');
}

// --- extra pin-tree files (existence + extension filters) --------------------

// Spike-relative files that exist ONLY so manifest rows pass the stale check
// and the derivation legs can walk them. The .txt row proves dirPinRows'
// extension filter drops it.
const PIN_TREE_FILES = {
  [`vendor/dsh/agent@${VER}/package.json`]: '{"name":"agent"}\n',
  [`vendor/dsh/agent@${VER}/lib/index.js`]: 'export const agent = 1;\n',
  [`vendor/dsh/brand@${VER}/package.json`]: '{"name":"brand"}\n',
  [`vendor/dsh/brand@${VER}/lib/index.js`]: 'export const brand = 1;\n',
  [`vendor/npm/@deepseek-ai/dsh-anonymous@${VER}/package.json`]: '{"name":"dsh-anonymous"}\n',
  [`vendor/npm/@deepseek-ai/dsh-anonymous@${VER}/lib/index.js`]: 'export const a = 1;\n',
  [`vendor/npm/@deepseek-ai/dsh-goalish@${VER}/package.json`]: '{"name":"dsh-goalish"}\n',
  [`vendor/npm/@deepseek-ai/dsh-goalish@${VER}/lib/index.js`]: 'export const g = 1;\n',
  'vendor/npm/@noble/hashes@2.3.0/lib/index.js': 'export const h = 1;\n',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/index.js': 'export const p = 1;\n',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/index.json': '{}\n',
  'vendor/npm/@earendil-works/pi-ai@0.85.1/dist/notes.txt': 'dropped by the ext filter\n',
  'vendor/npm/cordis@4.0.2/package.json': '{"name":"cordis"}\n',
  // the zod pin: the closure walker recomputes index.js → checks.js → errors.js
  [ZOD_PIN + '/index.js']: "import './v4/classic/checks.js';\n",
  [ZOD_PIN + '/v4/classic/checks.js']: "export * from '../../errors.js';\n",
  [ZOD_PIN + '/errors.js']: 'export class ZodError extends Error {}\n',
  'vendor/npm/pin@1.0.0/package.json': '{"name":"pin"}\n',
};

// --- the fixture -------------------------------------------------------------

/** One tmp repo: real tool sources + a green manifest set. Mutate it freely
 * (write/remove) and run the copied tools inside it via run()/json(). */
export class StagingFixture {
  constructor(root) {
    this.root = root;
    this.spike = join(root, 'runtime', 'spike');
  }

  abs(rel) { return join(this.root, rel); }

  write(rel, content) {
    mkdirSync(dirname(join(this.root, rel)), { recursive: true });
    writeFileSync(join(this.root, rel), content);
  }

  /** Write a spike file AND keep the harmony rawfile mirror row in step
   * (only needed for rows some manifest names). */
  writeSpike(rel, content) {
    this.write(join('runtime/spike', rel), content);
    const raw = join('hosts/harmony/entry/src/main/resources/rawfile/spike', rel);
    if (existsSync(join(this.root, raw))) this.write(raw, content);
  }

  read(rel) { return readFileSync(join(this.root, rel), 'utf8'); }

  remove(rel) { rmSync(join(this.root, rel)); }

  /** Run one of the copied tools; node CLI semantics verbatim (exit codes
   * 0/1/2, stdout/stderr text). */
  run(tool, args = []) {
    const r = spawnSync(process.execPath, [join('tools', tool), ...args], {
      cwd: this.root, encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  json(tool, args = []) {
    const r = this.run(tool, [...args, '--json']);
    return { ...r, data: JSON.parse(r.stdout) };
  }

  /** Add rows to Index.ets BUNDLE_FILES and materialize their rawfile/spike
   * copies (the stale check's root) — rows arrive covered by the primary
   * harmony surface. Spike rows copy from the spike tree. */
  addBundleRows(rows) {
    const ets = join('hosts/harmony/entry/src/main/ets/pages/Index.ets');
    const src = this.read(ets);
    const at = src.indexOf('const BUNDLE_FILES: string[] = [');
    const end = src.indexOf('];', at);
    const added = rows.map((r) => `  '${r}',`).join('\n');
    this.write(ets, `${src.slice(0, end)}${added}\n${src.slice(end)}`);
    for (const row of rows) this.mirrorRawfileRow(row);
  }

  /** The harmony rawfile/spike copy of one BUNDLE_FILES row: spike rows
   * byte-copy; webclient rows map to their presentation sources. */
  mirrorRawfileRow(row) {
    const stagedPrefix = row.split('/').slice(0, 2).join('/');
    const staged = WEBCLIENT_TREES.find((t) => `webclient/${t.staged}` === stagedPrefix);
    const source = staged
      ? join(this.root, staged.dir, row.split('/').slice(2).join('/'))
      : join(this.spike, row);
    this.write(join('hosts/harmony/entry/src/main/resources/rawfile/spike', row), readFileSync(source, 'utf8'));
  }
}

/** Assemble the green fixture: every manifest agrees with reality, so both
 * staging tools exit 0 on it. Returns the fixture handle. */
export function buildGreenFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-staging-fx-'));
  const fx = new StagingFixture(root);
  for (const tool of TOOL_FILES) {
    fx.write(join('tools', tool), readFileSync(join(REPO, 'tools', tool), 'utf8'));
  }
  for (const [rel, src] of Object.entries(SPIKE_FILES)) fx.writeSpike(rel, src);
  for (const [rel, src] of Object.entries(PIN_TREE_FILES)) {
    fx.write(join('runtime/spike', rel), src);
  }
  for (const t of WEBCLIENT_TREES) fx.write(join(t.dir, 'index.html'), `<h1>${t.staged}</h1>\n`);
  fx.write('hosts/harmony/entry/src/main/ets/pages/Index.ets', indexEts(derivedBundleRows()));
  fx.write('hosts/harmony/ci/vendor-official.sh', vendorOfficialSh());
  fx.write('hosts/android/ci/stage-spine-closure.sh', stageSpineClosureSh());
  fx.write('hosts/ios/Tools/gen_bundle_header.py', genBundleHeaderPy());
  mirrorRawfileBundle(fx);
  return fx;
}

/** The harmony rawfile/spike copy of every BUNDLE_FILES row (the stale
 * check's root): spike rows byte-copy; webclient rows map to their
 * presentation sources. */
function mirrorRawfileBundle(fx) {
  for (const row of derivedBundleRows()) fx.mirrorRawfileRow(row);
}
