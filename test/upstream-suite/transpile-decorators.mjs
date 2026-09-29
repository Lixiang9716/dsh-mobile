// transpile-decorators.mjs — the TC39 method-decorator lowering (W8) and the
// bundle-manifest / seed-tree source-rewrite families, split out of
// transpile-rewrites.mjs when that file crossed the code-size budget. Pure
// functions and tables over source text: NO imports at all (the importer
// pulls back what its own paths need — a static import back into
// transpile-rewrites.mjs would close a module cycle).

/** W8 (2026-09-29): the TC39 method-decorator lowering — the wall that kept
 * the gateway.host / typert-protocol spec families out of the staged tree
 * since wave 3. esbuild's TS transform passes ES decorators through
 * verbatim and quickjs-ng 0.17 refuses to parse them; the corpus's two
 * decorators (@Remote, @RemoteScope(...) — single-line, instance methods
 * only, 90 call sites) all register through the STANDARD `context.
 * addInitializer` seam and only ever MARK the class prototype (deduped),
 * so the exact engine semantics survive a source-level lowering that
 * invokes the REAL decorator function over a faithful TC39 method context:
 *
 *   @Remote
 *   create(agent) { ... }
 *     →  create(agent) { ... }
 *        static { __dshDecorate(Remote, "create", this); }
 *
 * The static block runs at class definition in declaration order (the
 * engine runs the initializers at first construction, also in declaration
 * order — mark() dedupes, so the earlier marking is unobservable except
 * for inspection before construction, which the corpus never does); `this`
 * in a static block IS the class, and the initializer is invoked with
 * `Object.create(proto)` as the receiver exactly because the one
 * initializer body in the corpus reads only `Object.getPrototypeOf(this)`.
 * Unlike stripping (the prior verdict's objection — it would drop the
 * @Remote registration semantics the specs exist to exercise), the
 * decorated methods stay whole and the REAL vendored decorator decides the
 * registration. Deliberately NARROW: a file without the exact decorator
 * line shape is returned untouched, a decorated member the shape-checker
 * cannot certify bails the WHOLE file back to the original source (the
 * exclusion scan then keeps its named verdict — fail loud, never a silent
 * half-transform). Helper files (the 35 'bundled helper: decorators'
 * exclusions) reach the same lowering through BARE_EXTERNAL_PLUGIN's
 * bundled-helper onLoad in transpile-rewrites.mjs. */
export const DECORATOR_LINE = /^[ \t]*@([A-Za-z_$][\w$]*(?:[ \t]*\([^)]*\))?)[ \t]*$/;
export const DECORATED_MEMBER = /^[ \t]*(?:(?:public|private|protected|async|override|readonly)[ \t]+)*(?:\*[ \t]*)?([A-Za-z_$][\w$]*)[ \t]*\(/;
export const CLASS_OPEN = /^[ \t]*(?:export\s+|default\s+|abstract\s+)*class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$.]+))?\s*\{$/;
export const CLASS_ONE_LINER = /^([ \t]*(?:export\s+|default\s+|abstract\s+)*class\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$.]+)[ \t]*)\{[ \t]*\}[ \t]*$/;
export const DSH_DECORATE_HELPER = [
  'function __dshDecorate(dec, name, ctor) {',
  '  const proto = ctor.prototype;',
  '  let initializer;',
  '  const context = {',
  "    kind: 'method',",
  '    name,',
  '    static: false,',
  '  private: false,',
  '    metadata: ctor[Symbol.metadata],',
  '    access: { get: (o) => o[name], has: (o) => name in o },',
  '    addInitializer(fn) {',
  "      if (typeof fn !== 'function') throw new TypeError('addInitializer expects a function');",
  '      if (initializer !== undefined) throw new TypeError("addInitializer called twice");',
  '      initializer = fn;',
  '    },',
  '  };',
  '  const replacement = dec(proto[name], context);',
  '  if (replacement !== undefined) proto[name] = replacement;',
  '  if (initializer !== undefined) initializer.call(Object.create(proto));',
  '  let record = __dshDecorations.get(ctor);',
  '  if (record === undefined) { record = []; __dshDecorations.set(ctor, record); }',
  '  record.push({ dec, name });',
  '}',
  'function __dshDecorateInherited(ctor) {',
  '  const own = new Set((__dshDecorations.get(ctor) ?? []).map((e) => e.name));',
  '  let ancestor = Object.getPrototypeOf(ctor);',
  '  while (ancestor !== null && ancestor !== Object.prototype) {',
  '    for (const entry of __dshDecorations.get(ancestor) ?? []) {',
  '      if (own.has(entry.name)) continue;',
  '      __dshDecorate(entry.dec, entry.name, ctor);',
  '      own.add(entry.name);',
  '    }',
  '    ancestor = Object.getPrototypeOf(ancestor);',
  '  }',
  '}',
  'const __dshDecorations = new WeakMap();',
].join('\n');

/** Net brace delta of one line of member body, strings/comments/template
 * contents skipped (the corpus's decorated bodies are short and flat; the
 * ${} expressions inside template literals still count). */
export const lineBraceDelta = (line) => {
  let depth = 0;
  let quote = null;
  for (let at = 0; at < line.length; at++) {
    const ch = line[at];
    if (quote !== null) {
      if (ch === '\\') at++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && line[at + 1] === '/') break;
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
};

/** A tracked CLASS line: the open (`class C extends B {`) or the empty
 * one-liner (`class C extends B {}`). A subclass of an already-decorated
 * class needs the inherited-replay block as its FIRST class element: real
 * TC39 runs the base's method initializers with the SUBCLASS instance at
 * construction, which lands the prototype markers on the subclass's own
 * prototype (the gateway's inherited-SRC discovery asserts exactly that
 * shape). Returns { lines, name, replay } — the lines to emit in order,
 * the class name, and whether the replay fired — or null when the line is
 * neither shape (the two regexes are disjoint: one ends `{`, the other
 * `}`, so the order of the two probes below is unobservable). */
const classLineReplay = (line, decoratedClasses) => {
  const oneLiner = CLASS_ONE_LINER.exec(line);
  if (oneLiner !== null && decoratedClasses.has(oneLiner[3].split('.')[0])) {
    return {
      lines: [`${oneLiner[1]}{ static { __dshDecorateInherited(this); } }`],
      name: oneLiner[2],
      replay: true,
    };
  }
  const open = CLASS_OPEN.exec(line);
  if (open === null) return null;
  const replay = open[2] !== undefined && decoratedClasses.has(open[2].split('.')[0]);
  return {
    lines: replay ? [line, '  static { __dshDecorateInherited(this); }'] : [line],
    name: open[1],
    replay,
  };
};

/** Copy one decorated member line and its body into `out`, then append the
 * static __dshDecorate blocks (one per pending decorator, declaration
 * order). Returns the next line index, or null when the body never
 * balances — the bail-loud shape. */
const emitDecoratedMember = (out, lines, at, line, name, exprs) => {
  out.push(line);
  at++;
  let depth = lineBraceDelta(line);
  while (depth > 0 && at < lines.length) {
    out.push(lines[at]);
    depth += lineBraceDelta(lines[at]);
    at++;
  }
  if (depth !== 0) return null; // unbalanced: bail loud
  for (const expr of exprs) {
    out.push(`  static { __dshDecorate(${expr}, ${JSON.stringify(name)}, this); }`);
  }
  return at;
};

/** The per-line walk over one candidate file's lines: returns the lowered
 * lines, or null when the shape-checker cannot certify the file (the
 * caller bails the WHOLE file back to its original source). */
const walkDecoratedMembers = (lines) => {
  const out = [];
  let pending = []; // decorator expressions awaiting their member, in order
  const decoratedClasses = new Set(); // classes owning __dshDecorate blocks (or inheriting them)
  let currentClass = null; // the innermost class-open seen (corpus: flat, top-level)
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    const decorator = DECORATOR_LINE.exec(line);
    if (decorator !== null) {
      pending.push(decorator[1].replace(/\s+/g, ' ').trim());
      at++;
      continue;
    }
    const cls = classLineReplay(line, decoratedClasses);
    if (cls !== null) {
      out.push(...cls.lines);
      currentClass = cls.name;
      if (cls.replay) decoratedClasses.add(cls.name);
      at++;
      continue;
    }
    if (pending.length === 0) { out.push(line); at++; continue; }
    // Between the decorator(s) and their member only blanks/comments are legal.
    const member = DECORATED_MEMBER.exec(line);
    if (member === null) {
      if (/^[ \t]*($|\/\/|\/\*)/.test(line)) { out.push(line); at++; continue; }
      return null; // unexpected shape: bail loud (named exclusion upstream)
    }
    const next = emitDecoratedMember(out, lines, at, line, member[1], pending);
    if (next === null) return null; // unbalanced: bail loud
    at = next;
    if (currentClass !== null) decoratedClasses.add(currentClass);
    pending = [];
  }
  if (pending.length > 0) return null; // trailing decorators: bail loud
  return out;
};

export const lowerDecorators = (source) => {
  if (!new RegExp(DECORATOR_LINE.source, 'm').test(source) || source.includes('__dshDecorate(')) return source;
  const lowered = walkDecoratedMembers(source.split('\n'));
  if (lowered === null) return source; // the walk bailed: a shape it cannot certify
  return `${DSH_DECORATE_HELPER}\n${lowered.join('\n')}`;
};

/** The bundle-manifest family (W5-Q, 2026-09-28): the bundle/agent-team
 * profile specs read the SPEC'S OWN PACKAGE manifest off disk —
 * `fileURLToPath(new URL('..', import.meta.url))` is the package root on the
 * monorepo layout (spec at <pkg>/tests/x.spec.ts), but flat staging puts the
 * spec at /upstream-tests/<stem>.spec.mjs, so the '..' lands at '/' and the
 * read would need files the VFS roots refuse. Two moves, same pattern as
 * the createRequire JSON hoist in transpile-rewrites.mjs:
 * 1. REWRITE the root computation to the spec's own directory
 *    (`new URL('.', ...)`) — the read paths become /upstream-tests/package.json
 *    and the manifest-named patch file, inside the seeded VFS root.
 * 2. EMIT the REAL package-root files (package.json + the patch file) as seed
 *    data through the existing .fixtures.js module — the driver already
 *    imports and seeds that before the tests run. Bytes come from the pinned
 *    submodule verbatim (D6: read-only upstream, never a modified copy), so
 *    every attribution assertion (dsh.bundle.patch field, dependencies map,
 *    patch rows) runs against the true manifest.
 * One spec per runtime, so the flat /upstream-tests/package.json namespace
 * never collides (the fixtures seeding already relies on the same fact). */
export const BUNDLE_MANIFEST_PACKAGES = new Map([
  ['bundle/base/tests/base.spec.ts', 'bundle/base'],
  ['bundle/acp-app/tests/acp-app.spec.ts', 'bundle/acp-app'],
  ['bundle/sdk-app/tests/sdk-app.spec.ts', 'bundle/sdk-app'],
  ['bundle/sdk-minimal/tests/sdk-minimal.spec.ts', 'bundle/sdk-minimal'],
  ['experimental/agent-team-profile/tests/profile.spec.ts', 'experimental/agent-team-profile'],
  ['experimental/agent-team-web-profile/tests/profile.spec.ts', 'experimental/agent-team-web-profile'],
]);
/** Files the family reads at the package root, by name. base's second test
 * also stats 'windows.cordis.patch.yml' and expects FALSE — absent here, the
 * seeded-view existsSync answers false, which is the asserted fact. */
export const BUNDLE_MANIFEST_FILES = ['package.json', 'cordis.patch.yml'];
export const rewriteBundleManifestRoot = (source) => source
  .replaceAll("new URL('..', import.meta.url)", "new URL('.', import.meta.url)")
  .replaceAll('new URL("..", import.meta.url)', 'new URL(".", import.meta.url)');

/** The layout-tree family (W5-Q, 2026-09-28): specs that audit the VENDORED
 * SOURCE TREE itself (the experimental Inspector's client/host path
 * mirroring) walk `../src/` off the monorepo layout — the same flat-staging
 * problem the bundle-manifest family has, at tree scale. Two moves: rewrite
 * the tree roots to the spec's own directory, and SEED the tree (verbatim
 * submodule bytes, D6) plus the named compiler manifests through the
 * existing .fixtures.js delivery. The staged spec then re-audits the REAL
 * upstream sources through fs.readFile/readdir over the seeded VFS view. */
export const SEED_TREE_SPECS = new Map([
  ['experimental/inspector/tests/layout.host.spec.ts', {
    package: 'experimental/inspector',
    rewrites: [
      ["new URL('../src/', import.meta.url)", "new URL('./src/', import.meta.url)"],
      ['new URL("../src/", import.meta.url)', 'new URL("./src/", import.meta.url)'],
      ["new URL('../', import.meta.url)", "new URL('./', import.meta.url)"],
      ['new URL("../", import.meta.url)', 'new URL("./", import.meta.url)'],
    ],
    tree: 'src',
    files: ['tsconfig.host.json', 'tsconfig.client.json'],
    mirrorTests: true,
  }],
]);
export const rewriteSeedTreeRoots = (source, rewrites) => {
  let out = source;
  for (const [from, to] of rewrites) out = out.replaceAll(from, to);
  return out;
};
