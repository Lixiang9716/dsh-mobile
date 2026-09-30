// dsh:logging-exempt (node-side driver: its stdout IS the product — the
// runner reads the endpoint announce from it)
/**
 * mock-market-server.mjs — the loopback FILE HOSTING for the marketplace
 * E2E (proposal model: "a signed static index.json plus package tarballs on
 * plain file hosting" — this is that plain file hosting, no more). Serves
 * the runner-generated catalog directory over 127.0.0.1 HTTP:
 *
 *   GET /index.json, /index-<variant>.json   catalog documents (from disk,
 *                                            per request — files may land
 *                                            after the server starts)
 *   GET /packages/<name>.tgz                 package tarballs
 *   GET /_tamper/blob                        TEST CONTROL: flip to serving a
 *   GET /_tamper/none                        byte-tampered dsh-fs tarball —
 *                                            the hostile-mirror rung of the
 *                                            tamper ladder (the catalog
 *                                            stays honest; the hosting is
 *                                            what a compromised mirror
 *                                            corrupts)
 *
 * The tamper is DETERMINISTIC: one byte of the bundle member's content
 * flips, so the digest drift is stable run to run. The announce and telemetry
 * lines on stdout are diagnostics — the checker only reads the CLI's stdout.
 *
 * usage: node mock-market-server.mjs <root-dir>   (announces MARKET_BASE_URL=)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
let tamperBlob = false;

const serveFile = async (res, path, contentType) => {
  let bytes = await readFile(path);
  if (tamperBlob && path.endsWith('dsh-fs@0.1.0.tgz')) {
    // Flip one byte deep in the bundle member's content — the served BYTES
    // no longer match the SIGNED blobSha256. Deterministic tamper site: the
    // final content byte before the archive terminator blocks.
    bytes = Buffer.from(bytes);
    bytes[bytes.length - 1025] ^= 0x01;
  }
  res.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length });
  res.end(bytes);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  console.log(JSON.stringify({ req: req.method, path: url.pathname, tamper: tamperBlob }));
  try {
    if (url.pathname === '/_tamper/blob') {
      tamperBlob = true;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('tamper armed\n');
      return;
    }
    if (url.pathname === '/_tamper/none') {
      tamperBlob = false;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('tamper disarmed\n');
      return;
    }
    const safe = url.pathname.slice(1).split('/').filter((s) => s !== '' && s !== '..');
    const target = join(ROOT, ...safe);
    if (!target.startsWith(ROOT + sep)) throw new Error('path escape');
    const type = extname(target) === '.tgz' ? 'application/gzip' : 'application/json';
    await serveFile(res, target, type);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`not found: ${url.pathname}\n`);
    console.log(JSON.stringify({ miss: url.pathname, err: String(err) }));
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
console.log(`MARKET_BASE_URL=http://127.0.0.1:${server.address().port}`);
console.log(`MARKET_ROOT=${ROOT}`);
