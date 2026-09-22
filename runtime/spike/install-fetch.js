/**
 * install-fetch — the FETCH-BASED installer (M3 scope: "install a package
 * fetched over httpFetch"). `installFromFetch` consumes a fetch implementation
 * that matches the gateway shim's `httpFetch` response shape —
 * `{status, body: AsyncIterable<Uint8Array>}` — accumulates the STREAMING
 * body into bytes (event-driven deltas, never a blocking whole-result), and
 * hands them to the existing §4 install pipeline. The fetch impl is a
 * PARAMETER, not an import (D5/D8: no hostType branching):
 *
 *   - the iOS carrier host passes the REAL gateway `httpFetch` (on-device
 *     E2E: the package is served by the loopback carrier itself);
 *   - hosts without a network surface (the desktop CLI smoke backend
 *     declares httpFetch unavailable, honestly) pass a stub with the same
 *     response shape — the install.full-cycle scenario logs its stub as
 *     `fetch.stub`, keeping the streaming path under test everywhere.
 *
 * Lifecycle progress rides the same `on(step, fields)` callback as the
 * pipeline (fetch.start / fetch.status / fetch.body), so the calling
 * scenario owns the E2E log stream. A non-200 status rejects with
 * InstallRejected BEFORE anything is stored.
 */
import { createLogger } from 'logger.js';
import { installPackage, InstallRejected } from 'install-pipeline.js';

const log = createLogger('dsh.install-fetch');

/**
 * Fetch `url` through `fetchImpl`, drain the streaming body into bytes, and
 * run the install transaction. Args: {fetchImpl, url, id, trust, txId, on,
 * journal}. Resolves whatever installPackage resolves; rejects with
 * InstallRejected (network/package) or the pipeline's rejections.
 */
export const installFromFetch = async ({ fetchImpl, url, id, trust, txId, on = () => {}, journal = false }) => {
  log.debug('fetch install begin', { url, id, txId });
  if (typeof fetchImpl !== 'function') {
    throw new InstallRejected('invalid', 'installFromFetch needs a fetchImpl');
  }
  on('fetch.start', { url });
  const res = await fetchImpl(url);
  if (res.status !== 200) {
    throw new InstallRejected('network', `fetch ${url} status ${res.status}`, { status: res.status });
  }
  on('fetch.status', { status: res.status });
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    total += chunk.length;
  }
  on('fetch.body', { chunks: chunks.length, bytes: total });
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  log.debug('fetch body drained', { chunks: chunks.length, bytes: total });
  return await installPackage({ id, bytes, trust, txId, on, journal });
};
