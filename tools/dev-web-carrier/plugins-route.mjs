// dsh:logging-exempt (node-side driver: console IS the product)
/**
 * plugins-route.mjs — the `/plugins` prefix route, the Node port of the
 * Android carrier's CarrierPlugins.kt (the client-modules bundle surface
 * of docs/webserver-contract.md §2.5). Serves the revisioned
 * single-resource combo `/plugins/??<id>/client.js&rev=<rev>`, the
 * aggregate combine form, and the `.map` identity maps; revs are the
 * COMPOSED GRAPH's (the runtime's `web.boot` rows — applyRuntimeRevs
 * parity: initial carrier revs are content hashes, the graph's revs win).
 * Anything else under /plugins is an unknown resource → 404.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SCRIPT_MIME = 'text/javascript; charset=utf-8';
const MAP_MIME = 'application/json; charset=utf-8';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Strips bundle-local debug trailers and keeps a trailing newline
 * (upstream prepareSource). */
export const prepareSource = (raw) => {
  const lines = raw.split('\n');
  while (lines.length > 0) {
    const last = lines[lines.length - 1].replace(/\r$/, '');
    if (last.startsWith('//# sourceMappingURL=') || last.startsWith('//# sourceURL=')) {
      lines.pop();
      continue;
    }
    break;
  }
  let source = lines.join('\n');
  if (source.length > 0 && !source.endsWith('\n')) source += '\n';
  return source;
};

const sha1_12 = (data) => createHash('sha1').update(data).digest('hex').slice(0, 12).toLowerCase();

/** sha1 content hash shortened to 12 hex (upstream shortHash). */
export const shortHash = (input) => sha1_12(Buffer.from(input, 'utf8'));

/** Upstream framedHash: length-prefixed parts so bytes cannot move across
 * field boundaries. */
export const comboRev = (ids, revs) => {
  const chunks = [Buffer.from('combo\0', 'utf8')];
  ids.forEach((id, i) => {
    chunks.push(
      Buffer.from(`${Buffer.byteLength(id, 'utf8')}:`, 'utf8'), Buffer.from(id, 'utf8'),
      Buffer.from(`${Buffer.byteLength(revs[i], 'utf8')}:`, 'utf8'), Buffer.from(revs[i], 'utf8'),
    );
  });
  return sha1_12(Buffer.concat(chunks));
};

/** Identity per-line map for one generated source (upstream
 * identitySectionMap), wrapped in the combo indexed-map form. */
export const identityMap = (source, sourceURL) => {
  const lineCount = Math.max(source.split('\n').length, 1);
  const mappings = Array.from({ length: lineCount }, (_, i) => (i === 0 ? 'AAAA' : 'AACA')).join(';');
  const section = {
    version: 3, names: [], sources: [sourceURL], sourcesContent: [source], mappings,
  };
  const wrapped = {
    version: 3, file: 'client.js',
    sections: [{ offset: { line: 0, column: 0 }, map: section }],
  };
  return JSON.stringify(wrapped).replaceAll('<', '\\u003c') + '\n';
};

class Entry {
  constructor(id, file) {
    this.id = id;
    this.source = prepareSource(readFileSync(file, 'utf8'));
    this.rev = shortHash(this.source);
  }
}

/** The /plugins route over the staged plugin set. `bundles` is the staged
 * list in delivery order: [{ id, file }] pointing at each package's
 * lib/client.js. */
export class PluginsRoute {
  constructor(bundles) {
    this.entries = [];
    this.byId = new Map();
    for (const { id, file } of bundles) {
      const entry = new Entry(id, file);
      this.entries.push(entry);
      this.byId.set(id, entry);
    }
  }

  /** Adopt the COMPOSED GRAPH's rows (web.boot): rows whose id matches a
   * staged entry override its rev (the graph's revs, not content hashes). */
  applyRuntimeRevs(rows) {
    for (const row of rows) {
      const entry = this.byId.get(row.id);
      if (entry !== undefined && typeof row.rev === 'string') entry.rev = row.rev;
    }
  }

  /** Split `<resources>&rev=<rev>`; nil-shaped queries return null (404). */
  parseComboQuery(query) {
    const at = query.indexOf('&rev=');
    if (at < 0) return null;
    const resources = query.slice(0, at).split(',').filter((s) => s.length > 0);
    const rev = query.slice(at + '&rev='.length);
    if (resources.length === 0) return null;
    return { resources, rev };
  }

  /** The combo body when every listed `<id>/client.js` is staged and the
   * declared rev matches the ordered combo rev; null otherwise (404). */
  comboBody(resources, rev) {
    if (!resources.every((r) => r.endsWith('/client.js'))) return null;
    const ids = resources.map((r) => r.slice(0, -'/client.js'.length));
    const resolved = ids.map((id) => this.byId.get(id));
    if (resolved.some((e) => e === undefined)) return null;
    if (comboRev(ids, resolved.map((e) => e.rev)) !== rev) return null;
    let body = '';
    for (const entry of resolved) body += entry.source + ';\n';
    const mapResources = ids.map((id) => `${id}/client.js.map`).join(',');
    body += `//# sourceMappingURL=/plugins/??${mapResources}&rev=${rev}\n`;
    return body;
  }

  /** Prefix-route handler: (request, respond) with respond(status, mime,
   * body, headers). */
  handler = (request, respond) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return respond(405, 'text/plain', '');
    }
    const rawPath = request.rawPath;
    if (rawPath === '/plugins' || rawPath === '/plugins/') return this.serveCombo(request, respond);
    return this.serveSingle(request, respond);
  };

  /** The combine form rides the stored query (everything after `??`). */
  serveCombo(request, respond) {
    const query = (request.query ?? '').replace(/^\?+/, '');
    const parsed = query.length > 0 ? this.parseComboQuery(query) : null;
    const out = parsed === null ? null : this.comboBody(parsed.resources, parsed.rev);
    if (out === null) return respond(404, 'text/plain', '');
    respond(200, SCRIPT_MIME, out, { 'Cache-Control': CACHE_CONTROL });
  }

  /** Single-resource forms: `/plugins/<id>/client.js?rev=` and the
   * `.map` identity map. */
  serveSingle(request, respond) {
    const pieces = request.path.split('/').filter((s) => s.length > 0);
    if (pieces.length !== 3 || pieces[0] !== 'plugins') return respond(404, 'text/plain', '');
    const entry = this.byId.get(pieces[1]);
    if (entry === undefined) return respond(404, 'text/plain', '');
    if (request.query !== `rev=${entry.rev}`) return respond(404, 'text/plain', '');
    if (pieces[2] === 'client.js') {
      const mapURL = `/plugins/??${entry.id}/client.js.map&rev=${entry.rev}`;
      const body = `${entry.source};\n//# sourceMappingURL=${mapURL}\n`;
      return respond(200, SCRIPT_MIME, body, { 'Cache-Control': CACHE_CONTROL });
    }
    if (pieces[2] === 'client.js.map') {
      return respond(200, MAP_MIME, identityMap(entry.source, `/plugins/${entry.id}/client.js`));
    }
    return respond(404, 'text/plain', '');
  }
}

