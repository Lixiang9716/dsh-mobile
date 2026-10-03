#!/usr/bin/env node
/**
 * Layout-truth probe — the surface the event log cannot see (issue #179
 * class): the log-verified drives assert runtime behavior, and touches at
 * occluded coordinates simply never reach the page, so a native bar painted
 * over the web surface was invisible to every scenario manifest. This probe
 * reads a UI tree dump and turns its GEOMETRY into the same assertion
 * currency everything else uses: one structured log record, judged by
 * test/e2e/check.mjs against scenarios/ui-occlusion.json exactly like any
 * other scenario event.
 *
 * The invariant asserted: the web surface owns its rectangle — no other
 * painted surface may sit over it, and every interactive element inside it
 * must be reachable inside that rectangle.
 *
 *   occluder    a node outside the web host's subtree that paints content
 *               (own or descendant text / interactive) and whose rectangle
 *               intersects the web host's — the action-bar-over-WebView bug;
 *   outside     an interactive descendant of the web host whose center falls
 *               outside the host rectangle (clipped or scrolled out);
 *   untappable  an interactive node with a zero-area rectangle.
 *
 * TWO dump formats, one record shape (the geometry vocabulary is shared):
 *   - Android `uiautomator dump` XML (native hierarchy; web content nodes
 *     appear when Chromium's accessibility is exposed to it — the occluder
 *     tier needs only the native nodes, so it works either way);
 *   - WebDriverAgent `/source?format=json` (iOS; `ios-ui.py tree <path>`
 *     saves it — the web element tree is always present there).
 *
 * The record rides the SAME captured log file on its OWN `dsh.ui.probe:`
 * prefix — a deliberate second stream, not a row in an existing scenario
 * manifest: committed evidence is frozen (matrix.mjs drift-checks verdicts
 * against their manifest's expect count), so wiring the probe into a leg
 * must never retro-count events a frozen capture cannot contain. The probe
 * is a stream enricher, not a verdict: exit 0 means "scanned + emitted"
 * (violations, if any, are the CHECKER's red), exit 2 is the loud failure
 * (unparsable dump, unparsable geometry, no web host in the dump — rule 5:
 * a probe that silently scanned nothing would be a vacuous pass).
 *
 * tools/ dev script (out of the logging gate's scope; console IS the product).
 *
 * usage: ui-probe.mjs --dump <uiautomator.xml | wda-source.json>
 *                     --scenario <id> [--append <log-file>] [--json <out>]
 *                     [--allow <label-or-class-substring>]...
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const usage = () => {
  console.error('usage: ui-probe.mjs --dump <xml|json> --scenario <id> [--append <log>] [--json <out>] [--allow <substr>]...');
  process.exit(2);
};

const parseArgs = (argv) => {
  const args = { allow: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) usage();
    const key = argv[i].slice(2);
    if (key === 'allow') { args.allow.push(argv[++i] ?? usage()); continue; }
    if (!['dump', 'scenario', 'append', 'json'].includes(key)) usage();
    args[key] = argv[++i];
  }
  if (!args.dump || !args.scenario) usage();
  return args;
};

const die = (msg) => {
  console.error(`ui-probe: FAIL: ${msg}`);
  process.exit(2);
};

const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

/** `[x1,y1][x2,y2]` (uiautomator) — the only geometry string it emits. */
const parseBounds = (s) => {
  const m = typeof s === 'string' ? /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(s.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
};

/** `{x,y,width,height}` (WDA) — fractional frames round to screen points. */
const parseFrame = (f) => {
  if (!f || typeof f !== 'object') return null;
  const [x, y, w, h] = [f.x, f.y, f.width, f.height].map(Number);
  return [x, y, w, h].every(Number.isFinite)
    ? [Math.round(x), Math.round(y), Math.round(x + w), Math.round(y + h)] : null;
};

const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const intersect = (a, b) => [
  Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3]),
];

/** One normalized tree across both formats: flat nodes with {cls, label,
 *  rect, interactive, order, parent}; rect = [x1, y1, x2, y2] screen points.
 *  Document order is the DFS index — uiautomator's XML is draw order (later
 *  siblings paint on top); WDA's source is the accessibility walk, so the
 *  recorded order stays informational there. `labeledTree` is the paint
 *  proof: a container paints when it or anything under it carries text (the
 *  action bar's own node is unlabeled; its title TextView is not). */
const normalize = (nodes, format) => {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.labeledSelf) n.labeledTree = true;
    if ((n.labeledSelf || n.labeledTree) && n.parent >= 0) nodes[n.parent].labeledTree = true;
  }
  return { nodes, format };
};

const parseUiautomator = (text) => {
  const nodes = [];
  const stack = [];
  // uiautomator's XML is machine-generated (`<node ...>` / `</node>` only);
  // a tag-tokenizer over that vocabulary is exact, no XML parser needed.
  const tagRe = /<(\/?)node\b([^>]*?)(\/?)>/g;
  const attrRe = /([a-zA-Z-]+)="([^"]*)"/g;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    if (m[1] === '/') { stack.pop(); continue; }
    const attrs = {};
    let a;
    while ((a = attrRe.exec(m[2])) !== null) attrs[a[1]] = unescapeXml(a[2]);
    const rect = parseBounds(attrs.bounds);
    if (!rect) die(`unparsable bounds on uiautomator node #${nodes.length}: ${JSON.stringify(attrs.bounds)}`);
    nodes.push({
      cls: attrs.class || '',
      label: attrs.text || attrs['content-desc'] || '',
      rect,
      interactive: attrs.clickable === 'true' || attrs['long-clickable'] === 'true' ||
        attrs.checkable === 'true' || attrs.scrollable === 'true',
      labeledSelf: (attrs.text || attrs['content-desc'] || '') !== '',
      visible: true,
      enabled: attrs.enabled !== 'false',
      order: nodes.length,
      parent: stack.length ? stack[stack.length - 1] : -1,
    });
    if (m[3] !== '/') stack.push(nodes.length - 1);
  }
  if (stack.length !== 0 || nodes.length === 0) {
    die('unparsable uiautomator XML (unbalanced or empty node tree)');
  }
  return normalize(nodes, 'uiautomator');
};

const parseWda = (text) => {
  let root;
  try {
    const payload = JSON.parse(text);
    root = payload.value ?? payload;
  } catch (e) {
    die(`unparsable WDA source JSON: ${e.message}`);
  }
  const nodes = [];
  // WDA types that take touches by themselves; web content surfaces mostly
  // as Button/Link/StaticText/Other inside the WebView element.
  const INTERACTIVE = new Set(['Button', 'Link', 'Cell', 'CheckBox', 'Slider', 'Switch',
    'TextField', 'SecureTextField', 'SearchField', 'Key', 'TabBarItem']);
  const walk = (node, parent) => {
    const rect = parseFrame(node.frame);
    if (!rect) die(`unparsable frame on WDA node #${nodes.length}: ${JSON.stringify(node.frame)}`);
    const idx = nodes.length;
    nodes.push({
      cls: node.type || '',
      label: node.label || node.name || '',
      rect,
      interactive: INTERACTIVE.has(node.type || ''),
      labeledSelf: (node.label || node.name || '') !== '',
      visible: node.isVisible !== false,
      enabled: node.isEnabled !== false,
      order: idx,
      parent,
    });
    for (const child of node.children ?? []) walk(child, idx);
  };
  walk(root, -1);
  if (nodes.length === 0) die('empty WDA source tree');
  return normalize(nodes, 'wda');
};

/** The web host: the largest WebView-typed surface (deterministic tie-break
 *  by document order). No WebView in the dump means the wrong moment or
 *  screen was captured — loud, never a vacuous scan. */
const findHost = (nodes) => {
  let host = -1;
  for (const n of nodes) {
    if (!/webview/i.test(n.cls)) continue;
    if (host < 0 || area(n.rect) > area(nodes[host].rect)) host = n.order;
  }
  if (host < 0) {
    die(`no WebView node in the dump (${nodes.length} nodes; top classes: ` +
      [...new Set(nodes.map((n) => n.cls))].slice(0, 5).join(', ') + ')');
  }
  return host;
};

const collectViolations = (nodes, host) => {
  const hostRect = nodes[host].rect;
  const isDescendant = (i) => {
    for (let p = nodes[i].parent; p >= 0; p = nodes[p].parent) if (p === host) return true;
    return false;
  };
  const isAncestor = (i) => {
    for (let p = nodes[host].parent; p >= 0; p = nodes[p].parent) if (p === i) return true;
    return false;
  };
  const centerOutside = (r) => {
    const c = [Math.round((r[0] + r[2]) / 2), Math.round((r[1] + r[3]) / 2)];
    return c[0] < hostRect[0] || c[1] < hostRect[1] || c[0] > hostRect[2] || c[1] > hostRect[3];
  };
  const violations = [];
  for (const n of nodes) {
    const paints = (n.labeledSelf || n.labeledTree || n.interactive) && n.visible !== false;
    if (n.order !== host && !isAncestor(n.order) && !isDescendant(n.order) &&
        paints && area(n.rect) > 0) {
      const over = intersect(n.rect, hostRect);
      if (area(over) > 0) {
        violations.push({
          kind: 'occluder', class: n.cls, label: n.label,
          rect: n.rect, overlap: over, after: n.order > host,
        });
      }
    }
    if (!n.interactive || n.enabled === false) continue;
    if (area(n.rect) === 0) {
      violations.push({ kind: 'untappable', class: n.cls, label: n.label, rect: n.rect });
      continue;
    }
    if (isDescendant(n.order) && centerOutside(n.rect)) {
      const c = [Math.round((n.rect[0] + n.rect[2]) / 2), Math.round((n.rect[1] + n.rect[3]) / 2)];
      violations.push({ kind: 'outside', class: n.cls, label: n.label, rect: n.rect, center: c });
    }
  }
  return { violations, isDescendant };
};

const judge = (args) => {
  const text = readFileSync(args.dump, 'utf8');
  const { nodes, format } = text.trimStart().startsWith('<')
    ? parseUiautomator(text) : parseWda(text);
  const host = findHost(nodes);
  const { violations, isDescendant } = collectViolations(nodes, host);

  // Deterministic report order: kind, then rectangle, then label.
  const rank = { occluder: 0, outside: 1, untappable: 2 };
  violations.sort((a, b) => (rank[a.kind] - rank[b.kind]) ||
    JSON.stringify(a.rect).localeCompare(JSON.stringify(b.rect)) ||
    String(a.label).localeCompare(String(b.label)));

  // Known-benign overlaps are excluded BY NAME and the exclusion rides the
  // record — an allowance the record does not carry would be a silent skip.
  const kept = args.allow.length === 0 ? violations : violations.filter((v) =>
    !args.allow.some((s) => `${v.label} ${v.class}`.toLowerCase().includes(s.toLowerCase())));
  return {
    scenario: args.scenario,
    event: 'ui.probe',
    probe: 'occlusion',
    violations: kept,
    scanned: { nodes: nodes.length, web: nodes.filter((n) => isDescendant(n.order)).length },
    format,
    ...(args.allow.length
      ? { allowed: args.allow, dropped: violations.length - kept.length } : {}),
  };
};

const run = () => {
  const args = parseArgs(process.argv.slice(2));
  const payload = judge(args);
  const line = `dsh.ui.probe: ${JSON.stringify({ level: 'info', data: [payload] })}`;
  if (args.append) appendFileSync(args.append, line + '\n');
  if (args.json) writeFileSync(args.json, JSON.stringify(payload, null, 2) + '\n');

  console.log(`ui-probe: ${args.scenario} scanned ${payload.scanned.nodes} nodes ` +
    `(${payload.scanned.web} under the web host), ${payload.violations.length} violation(s)` +
    (payload.dropped ? `, ${payload.dropped} allowed out` : ''));
  for (const v of payload.violations) {
    console.log(`  ${v.kind.padEnd(10)} ${JSON.stringify(v.rect)} ${v.class} ${JSON.stringify(v.label)}`);
  }
  process.exit(0);
};

run();
