// dsh:logging-exempt (test file: assertions ARE the product)
/**
 * plugins-route.test.mjs — the /plugins mux's own net
 * (tools/dev-web-carrier/plugins-route.mjs).
 *
 * SCOPE (honest boundary): this file covers the PURE, exported mux face —
 * prepareSource, shortHash, comboRev, identityMap, and the PluginsRoute
 * handler over synthetic bundle files in tmp. The dev-carrier server that
 * mounts the route (dev-carrier.mjs) starts a server at import and is not
 * importable in tests; its WS mux (handleMuxText) is not exported. The
 * server-mode faces (compose-boot/next-mode/ws-lite) ride live fixtures and
 * the e2e drive instead — stated here so the coverage report's excluded
 * files are a decision, not an accident.
 *
 * Behaviors pinned: the rev framing (length-prefixed parts, so bytes cannot
 * move across field boundaries — the upstream framedHash property), the
 * composed-graph parity rule (applyRuntimeRevs: the graph's revs win, the
 * content hash stops serving), the combo contract (every id staged + the
 * ordered combo rev matches, else 404), the .map identity maps, and the
 * status surface (405 non-GET/HEAD, 404 unknown/nil-shaped).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PluginsRoute, comboRev, identityMap, prepareSource, shortHash,
} from './plugins-route.mjs';

const tmpRoots = [];
function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugins-'));
  tmpRoots.push(root);
  return root;
}
afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

/** Two staged client bundles; returns the route + their content-hash revs. */
function stagedRoute() {
  const root = tmpRoot();
  const files = [
    { id: 'dsh-a', body: 'export const a = 1;\n' },
    { id: 'dsh-b', body: 'export const b = 2;\n//# sourceMappingURL=dev://x\n' },
  ];
  const bundles = files.map(({ id, body }) => {
    const file = join(root, `${id}.js`);
    writeFileSync(file, body);
    return { id, file };
  });
  const route = new PluginsRoute(bundles);
  return { route, revs: Object.fromEntries(route.entries.map((e) => [e.id, e.rev])) };
}

/** Collect the (status, mime, body, headers) a route handler responds with. */
function serve(route, request) {
  let captured;
  route.handler(request, (...args) => { captured = args; });
  const [status, mime, body, headers] = captured;
  return { status, mime, body, headers };
}

const comboRequest = (query) => ({
  method: 'GET', path: '/plugins/dsh-a/client.js', rawPath: '/plugins', query,
});

describe('prepareSource', () => {
  it('strips bundle-local debug trailers, keeps exactly one trailing newline', () => {
    // the trailing-newline case is the NORMAL build output — the upstream
    // trailer regexes are $-anchored and tolerate it (this exact case is
    // the parity bug the suite caught: a line-based scan stopped at the
    // empty line after \n and kept the trailers)
    expect(prepareSource('const a = 1;\n//# sourceMappingURL=x\n//# sourceURL=y\n')).toBe('const a = 1;\n');
    expect(prepareSource('const a = 1;')).toBe('const a = 1;\n');
    expect(prepareSource('const a = 1;\n')).toBe('const a = 1;\n');
    expect(prepareSource('const a = 1;\n//# sourceMappingURL=x')).toBe('const a = 1;\n');
    expect(prepareSource('')).toBe('\n'); // upstream: unconditional trailing \n
  });

  it('strips only TRAILING trailers, not mid-file ones', () => {
    expect(prepareSource('//# sourceMappingURL=x\nconst a = 1;\n')).toBe('//# sourceMappingURL=x\nconst a = 1;\n');
  });
});

describe('shortHash and comboRev', () => {
  it('shortHash: 12 lowercase hex, content-sensitive, stable', () => {
    const h = shortHash('hello');
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(shortHash('hello')).toBe(h);
    expect(shortHash('hellp')).not.toBe(h);
  });

  it('comboRev is length-prefixed: bytes cannot move across field boundaries', () => {
    // (id 'a', rev 'bc') and (id 'ab', rev 'c') are the same bytes without
    // framing — the hashes must differ (the upstream framedHash property)
    expect(comboRev(['a'], ['bc'])).not.toBe(comboRev(['ab'], ['c']));
  });

  it('comboRev is order-sensitive', () => {
    expect(comboRev(['a', 'b'], ['1', '2'])).not.toBe(comboRev(['b', 'a'], ['2', '1']));
  });
});

describe('identityMap', () => {
  it('wraps one identity section map; escapes <; ends with a newline', () => {
    const out = identityMap('const a = 1;\nconst b = "<x>";\n', '/plugins/dsh-a/client.js');
    expect(out.endsWith('\n')).toBe(true);
    expect(out).not.toContain('<');
    const parsed = JSON.parse(out);
    expect(parsed.version).toBe(3);
    expect(parsed.file).toBe('client.js');
    const section = parsed.sections[0];
    expect(section.offset).toEqual({ line: 0, column: 0 });
    expect(section.map.sources).toEqual(['/plugins/dsh-a/client.js']);
    expect(section.map.sourcesContent).toEqual(['const a = 1;\nconst b = "<x>";\n']);
    // one mapping segment per split-line of source (the port counts
    // split('\n').length; upstream's newlineCount counts \n chars — one
    // extra trailing segment, harmless to consumers, recorded in the PR)
    expect(section.map.mappings.split(';').length).toBe(3);
  });
});

describe('PluginsRoute combo forms', () => {
  it('serves the aggregate combo when every id is staged and the rev matches', () => {
    const { route, revs } = stagedRoute();
    const rev = comboRev(['dsh-a', 'dsh-b'], [revs['dsh-a'], revs['dsh-b']]);
    const r = serve(route, comboRequest(`dsh-a/client.js,dsh-b/client.js&rev=${rev}`));
    expect(r.status).toBe(200);
    expect(r.mime).toBe('text/javascript; charset=utf-8');
    expect(r.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
    // bodies in delivery order; dsh-b's DEV trailer is stripped (the route
    // appends its own final sourceMappingURL, so only the dev one proves it)
    expect(r.body).toContain('export const a = 1;');
    expect(r.body).toContain('export const b = 2;');
    expect(r.body).not.toContain('dev://x');
    expect(r.body.endsWith(`//# sourceMappingURL=/plugins/??dsh-a/client.js.map,dsh-b/client.js.map&rev=${rev}\n`)).toBe(true);
  });

  it('a mismatched combo rev → 404', () => {
    const { route } = stagedRoute();
    const r = serve(route, comboRequest('dsh-a/client.js&rev=deadbeefdead'));
    expect(r.status).toBe(404);
  });

  it('an unknown id in the combo → 404', () => {
    const { route, revs } = stagedRoute();
    const rev = comboRev(['dsh-a', 'ghost'], [revs['dsh-a'], 'x']);
    const r = serve(route, comboRequest(`dsh-a/client.js,ghost/client.js&rev=${rev}`));
    expect(r.status).toBe(404);
  });

  it('a resource that is not <id>/client.js → 404', () => {
    const { route, revs } = stagedRoute();
    const rev = comboRev(['dsh-a'], [revs['dsh-a']]);
    expect(serve(route, comboRequest(`dsh-a/other.js&rev=${rev}`)).status).toBe(404);
  });

  it('a nil-shaped query (no &rev=, or empty resource list) → 404', () => {
    const { route } = stagedRoute();
    expect(serve(route, comboRequest('')).status).toBe(404);
    expect(serve(route, comboRequest('&rev=abc')).status).toBe(404);
    expect(serve(route, comboRequest('no-rev-here')).status).toBe(404);
  });
});

describe('PluginsRoute single forms: the client.js face', () => {
  it('/plugins/<id>/client.js?rev=<content-hash> serves body + map URL', () => {
    const { route, revs } = stagedRoute();
    const r = serve(route, {
      method: 'GET', path: '/plugins/dsh-a/client.js', rawPath: '/plugins/dsh-a/client.js',
      query: `?rev=${revs['dsh-a']}`,
    });
    expect(r.status).toBe(200);
    expect(r.mime).toBe('text/javascript; charset=utf-8');
    expect(r.body.startsWith('export const a = 1;')).toBe(true);
    expect(r.body).toContain(`//# sourceMappingURL=/plugins/??dsh-a/client.js.map&rev=${revs['dsh-a']}`);
  });

  it('a wrong single-rev → 404 (the content hash gates the cached asset)', () => {
    const { route } = stagedRoute();
    const r = serve(route, {
      method: 'GET', path: '/plugins/dsh-a/client.js', rawPath: '/plugins/dsh-a/client.js',
      query: '?rev=000000000000',
    });
    expect(r.status).toBe(404);
  });
});

describe('PluginsRoute single forms: the .map face and statuses', () => {
  it('/plugins/<id>/client.js.map?rev= serves the identity map', () => {
    const { route, revs } = stagedRoute();
    const r = serve(route, {
      method: 'GET', path: '/plugins/dsh-a/client.js.map', rawPath: '/plugins/dsh-a/client.js.map',
      query: `?rev=${revs['dsh-a']}`,
    });
    expect(r.status).toBe(200);
    expect(r.mime).toBe('application/json; charset=utf-8');
    expect(JSON.parse(r.body).sections[0].map.sources).toEqual(['/plugins/dsh-a/client.js']);
  });

  it('unknown ids, malformed paths, and unknown resources → 404', () => {
    const { route, revs } = stagedRoute();
    const rev = revs['dsh-a'];
    expect(serve(route, { method: 'GET', path: '/plugins/ghost/client.js', rawPath: 'x', query: `?rev=${rev}` }).status).toBe(404);
    expect(serve(route, { method: 'GET', path: '/plugins/dsh-a/other.js', rawPath: 'x', query: `?rev=${rev}` }).status).toBe(404);
    expect(serve(route, { method: 'GET', path: '/plugins', rawPath: '/plugins', query: '' }).status).toBe(404);
  });

  it('non-GET/HEAD methods → 405', () => {
    const { route } = stagedRoute();
    const r = serve(route, { method: 'POST', path: '/plugins', rawPath: '/plugins', query: '' });
    expect(r.status).toBe(405);
  });

  it('HEAD passes the handler gate (the carrier answers HEAD like GET)', () => {
    const { route, revs } = stagedRoute();
    const r = serve(route, {
      method: 'HEAD', path: '/plugins/dsh-a/client.js', rawPath: 'x', query: `?rev=${revs['dsh-a']}`,
    });
    expect(r.status).toBe(200);
  });
});

describe("applyRuntimeRevs — the composed graph's revs win", () => {
  it('after adoption the graph rev serves and the content hash stops', () => {
    const { route, revs } = stagedRoute();
    route.applyRuntimeRevs([{ id: 'dsh-a', rev: 'graphrev0001' }]);
    expect(
      serve(route, {
        method: 'GET', path: '/plugins/dsh-a/client.js', rawPath: 'x', query: '?rev=graphrev0001',
      }).status,
    ).toBe(200);
    expect(
      serve(route, {
        method: 'GET', path: '/plugins/dsh-a/client.js', rawPath: 'x', query: `?rev=${revs['dsh-a']}`,
      }).status,
    ).toBe(404);
    // the combo tracks the adopted rev too
    const rev = comboRev(['dsh-a'], ['graphrev0001']);
    expect(serve(route, comboRequest(`dsh-a/client.js&rev=${rev}`)).status).toBe(200);
  });

  it('unknown ids and non-string revs are ignored', () => {
    const { route, revs } = stagedRoute();
    route.applyRuntimeRevs([{ id: 'ghost', rev: 'whatever000' }, { id: 'dsh-b', rev: 42 }]);
    expect(
      serve(route, {
        method: 'GET', path: '/plugins/dsh-b/client.js', rawPath: 'x', query: `?rev=${revs['dsh-b']}`,
      }).status,
    ).toBe(200);
  });
});
