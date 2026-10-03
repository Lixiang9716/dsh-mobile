/**
 * upstream/web-search-keyless.js — the KEYLESS WEB SEARCH LEG (issue #335 B5).
 *
 * The vendored `@deepseek-ai/dsh-tool-web` package surfaces `web_search` /
 * `web_fetch` to the model over the `ctx.web` capability seam
 * (`@deepseek-ai/dsh-web`), but every vendored search PROVIDER dialed the
 * desktop's network: `dsh-web-search-deepseek`/`-exa`/`-perplexity` call the
 * global `fetch`, which in this runtime is a FAIL-LOUD value
 * (upstream/shims/web-fetch-values.js — the gateway's `httpFetch` is the ONLY
 * network seam). A search leg that cannot dial is why the `tool-web` preset
 * row sat in preset-mobile-rows.js's mobile-absent set.
 *
 * This module is the mobile provider for that seam, per the vendored
 * `WebSearchProvider` contract ({id, available(), search(request, signal)} →
 * `{content?, sources[], truncated}` — the shape `dsh-tool-web` formats): a
 * DuckDuckGo HTML-endpoint scraper over gateway `httpFetch`, no API key. The
 * HTML parsing is a pure function (unit-tested against a fixed sample in
 * test/panel/web-search-keyless.test.js), the transport is injected so tests
 * run without the gateway.
 *
 * Honest limits (measured 2026-10-03 from a datacenter egress: both
 * html/lite endpoints answer HTTP 202 with the "bots use DuckDuckGo too"
 * challenge page): a keyless scraper is IP-reputation-sensitive. The
 * provider DETECTS the challenge and fails the call in-band with a coded
 * error naming the config escape hatches — it never returns a parsed
 * challenge page as if it were results. A seat whose network path is
 * challenged permanently points the endpoint at an unchallenged mirror
 * (host declaration `__dshWebSearch` or the launch environment's
 * `DSH_WEB_SEARCH_ENDPOINT` — the marketplaceIndex single-key opt-in
 * pattern); a keyed deployment mounts a keyed provider beside this one and
 * pins `searchProvider` on the seam. That owner-key follow-up is the
 * recorded gap, not a silent one.
 */
import { createLogger } from 'logger.js';

const log = createLogger('web.searchKeyless');

export const PROVIDER_ID = 'duckduckgo-keyless';

export const DEFAULT_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';

/** Machine-routable codes the tool layer surfaces in structured error
 * metadata (the vendored WebError is dsh-llm-closure-bound; the tool reads
 * `error.code`, never `instanceof`, so a coded plain Error carries the same
 * contract without dragging the llm closure into this module's importers —
 * the panel suite imports this file standalone). */
export const CODE_CHALLENGED = 'WEB_SEARCH_KEYLESS_CHALLENGED';
export const CODE_STATUS = 'WEB_SEARCH_KEYLESS_STATUS';
export const CODE_UNREACHABLE = 'WEB_SEARCH_KEYLESS_UNREACHABLE';
export const CODE_CONFIG = 'WEB_SEARCH_KEYLESS_CONFIG';

const CHALLENGE_MARKER = 'bots use duckduckgo';

// The coded-error constructor: `{name: 'WebError', code, message}`.
export const webSearchError = (code, message) => Object.assign(new Error(message), { name: 'WebError', code });

// The seat's config resolution: the host's `__dshWebSearch` declaration
// first, the launch environment second, the public endpoint last (the
// dsh-open-design two-tier shape). A non-string endpoint fails loud
// (rule 5); unknown fields pass through untouched — the seat may carry more
// for future keyed providers.
export const resolveSearchConfig = (declared = globalThis.__dshWebSearch, env = globalThis.__dshProfileLaunch) => {
  log.debug('resolveSearchConfig', { declared: Boolean(declared) });
  const endpoint = declared?.endpoint ?? env?.DSH_WEB_SEARCH_ENDPOINT ?? DEFAULT_SEARCH_ENDPOINT;
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw webSearchError(CODE_CONFIG, `web-search-keyless: endpoint must be a non-empty string, got ${JSON.stringify(endpoint)}`);
  }
  return { endpoint };
};

// Decode the entities DDG's HTML actually emits (&amp; &lt; &gt; &quot;
// &#x27; / &#39; and the numeric forms) — TWO passes, because DDG
// double-escapes inside snippet text (`&amp;quot;` arrives for a literal
// quote) and one pass would leave the inner escape showing. Deliberately
// NOT a general parser — the source list text needs exactly these.
const decodeEntities = (text) => [0, 1].reduce(
  (out) => out
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'),
  text,
);

// Strip the inline tags a snippet carries (<b> query highlights and
// friends) and collapse the whitespace the markup adds.
const stripTags = (html) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// Resolve one result href: DDG wraps outbound links in its
// `/l/?uddg=<url-encoded>&rut=…` redirect — the real target is the uddg
// parameter; a direct href passes through as-is. Protocol-relative spellings
// get https; anything unresolvable returns null so a malformed row drops
// instead of poisoning the source list.
export const resolveResultHref = (href) => {
  log.debug('resolveResultHref', { href: String(href).slice(0, 60) });
  let out = href;
  const uddg = /[?&]uddg=([^&"]+)/.exec(out ?? '');
  if (uddg) {
    try {
      out = decodeURIComponent(uddg[1]);
    } catch {
      return null; // a malformed escape is not a URL we can cite
    }
  }
  if (typeof out === 'string' && out.startsWith('//')) out = `https:${out}`;
  return typeof out === 'string' && /^https?:\/\//.test(out) ? out : null;
};

// The anchor scanner both the title walk and the snippet lookup share:
// every `<a …>inner</a>` as `{attrs, inner, start, end}` in document order.
const scanAnchors = (html) => {
  log.debug('scanAnchors', { bytes: html.length });
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const found = [];
  for (let match = anchor.exec(html); match !== null; match = anchor.exec(html)) {
    found.push({
      attrs: match[1],
      inner: match[2],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return found;
};

// One anchor's `class` attribute text ('' when absent).
const classOf = (attrs) => /\bclass\s*=\s*["']?([^"'>]*)/.exec(attrs)?.[1] ?? '';

// The snippet body for a title row: the first `result__snippet` element
// after `from` — an anchor on the html endpoint, a table cell on the lite
// endpoint — its inner markup stripped; null when the row carries none (a
// legal DDG shape; the snippet field is optional at the seam).
const snippetAfter = (html, from) => {
  log.debug('snippetAfter', { from });
  const window = html.slice(from, from + 4000);
  const element = /<([a-z]+)\b[^>]*\bclass\s*=\s*["'][^"']*(?:result__snippet|result-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i.exec(window);
  const text = element ? stripTags(element[2]) : '';
  return text.length > 0 ? text : null;
};

/** Parse one DuckDuckGo HTML results page into `{sources, truncated: false}`
 * — the seam's search shape. A source row is a `result__a` title anchor
 * (the lite endpoint's `result-link` spelling answers the same walk);
 * `url`/`title` resolve per {@link resolveResultHref}, the snippet is the
 * row's `result__snippet`. Duplicate URLs collapse (DDG repeats cache
 * hits). `maxResults` is the seam's own cap — nothing is truncated here. */
export const parseDuckDuckGoHtml = (html) => {
  log.debug('parseDuckDuckGoHtml', { bytes: html?.length ?? 0 });
  if (typeof html !== 'string') {
    throw webSearchError(CODE_STATUS, 'web-search-keyless: response body was not text');
  }
  const anchors = scanAnchors(html);
  const sources = [];
  const seen = new Set();
  for (const anchor of anchors) {
    if (!/\bresult__a\b|\bresult-link\b/.test(classOf(anchor.attrs))) continue;
    const url = resolveResultHref(/\bhref\s*=\s*["']?([^"'>]*)/.exec(anchor.attrs)?.[1]);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    const title = stripTags(anchor.inner);
    const snippet = snippetAfter(html, anchor.end);
    sources.push({
      url,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet !== null ? { snippet } : {}),
    });
  }
  return { sources, truncated: false };
};

// Whether the fetched page is DDG's anti-bot challenge (the HTTP 202 body
// and its 200 variants carry the marker sentence).
export const isChallengePage = (html) => typeof html === 'string' && html.toLowerCase().includes(CHALLENGE_MARKER);

/** Build the provider: the vendored `WebSearchProvider` shape over the
 * injected transport. `httpFetch(url, init)` must answer
 * `{status, body: AsyncIterable}` (the gateway contract); `decodeUtf8`
 * decodes the accumulated body bytes. Config comes from
 * {@link resolveSearchConfig} at construction; `available()` is the
 * contract's cheap local check (a well-formed http(s) endpoint), never a
 * network call — an unreachable or challenged endpoint surfaces at search
 * time as the coded in-band error, which is the honest state a keyless leg
 * can offer. */
// The browser-shaped headers a search GET carries (hoisted: the UA string
// is long and the provider body stays under the size gate's function cap).
const SEARCH_HEADERS = {
  accept: 'text/html',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
};

// The in-band error suffix every failure leg carries: what happened above,
// and the two escape hatches, in one line.
const explain = (headline) => `${headline} — if this network path stays challenged, set __dshWebSearch.endpoint / DSH_WEB_SEARCH_ENDPOINT to an unchallenged mirror (the marketplaceIndex opt-in pattern) or mount a keyed provider and pin ctx.web's searchProvider.`;

// One search round trip: dispatch, accumulate the byte body, decode, and
// classify the answer — challenge / non-2xx / parsed page. Transport and
// decoder are injected (the gateway face; the panel suite's mocks).
const searchOnce = async (httpFetch, decodeUtf8, endpoint, query, signal) => {
  log.debug('searchOnce', { query, endpoint });
  if (signal?.aborted) {
    throw webSearchError(CODE_UNREACHABLE, 'web-search-keyless: search aborted before dispatch');
  }
  const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
  let res;
  try {
    res = await httpFetch(url, { headers: SEARCH_HEADERS });
  } catch (error) {
    log.warn('search transport failed', { error: String(error?.message ?? error) });
    throw webSearchError(CODE_UNREACHABLE, explain(
      `web_search: the keyless endpoint could not be reached (${String(error?.message ?? error)})`));
  }
  const chunks = [];
  for await (const chunk of res.body) chunks.push(chunk);
  const html = decodeUtf8(chunks);
  if (res.status === 202 || isChallengePage(html)) {
    log.warn('search challenged', { status: res.status });
    throw webSearchError(CODE_CHALLENGED, explain(
      `web_search: the keyless endpoint answered with an anti-bot challenge (HTTP ${res.status})`));
  }
  if (res.status < 200 || res.status >= 300) {
    log.warn('search non-2xx', { status: res.status });
    throw webSearchError(CODE_STATUS, explain(`web_search: the keyless endpoint answered HTTP ${res.status}`));
  }
  return parseDuckDuckGoHtml(html);
};

/** Build the provider: the vendored `WebSearchProvider` shape over the
 * injected transport. `httpFetch(url, init)` must answer
 * `{status, body: AsyncIterable}` (the gateway contract); `decodeUtf8`
 * decodes the accumulated body bytes. Config comes from
 * {@link resolveSearchConfig} at construction; `available()` is the
 * contract's cheap local check (a well-formed http(s) endpoint), never a
 * network call — an unreachable or challenged endpoint surfaces at search
 * time as the coded in-band error, which is the honest state a keyless leg
 * can offer. */
export const createKeylessSearchProvider = ({ httpFetch, decodeUtf8, config } = {}) => {
  log.debug('createKeylessSearchProvider', {});
  if (typeof httpFetch !== 'function' || typeof decodeUtf8 !== 'function') {
    throw new Error('web-search-keyless: createKeylessSearchProvider needs an httpFetch and a decodeUtf8');
  }
  const { endpoint } = config ?? resolveSearchConfig();
  if (!/^https?:\/\//.test(endpoint)) {
    throw webSearchError(CODE_CONFIG, `web-search-keyless: endpoint is not an http(s) URL: ${endpoint}`);
  }
  return {
    id: PROVIDER_ID,
    available: () => true,
    search: (request, signal) => searchOnce(httpFetch, decodeUtf8, endpoint, request.query, signal),
  };
};

/** Mount the web plane on the spine ctx (called from boot.js's mountSpine):
 * the vendored `@deepseek-ai/dsh-web` seam service, this keyless provider
 * registered into it, then the vendored `@deepseek-ai/dsh-tool-web` tools —
 * SEARCH ONLY (`fetch: false`): no fetch provider exists over httpFetch yet,
 * and a row without one would fail every `web_fetch` at call time. All
 * imports are dynamic (the bridges must have registered `turndown` /
 * `@joplin/turndown-plugin-gfm` and armed the CJS loader before tool-web's
 * static graph links; the same ordering rule as the file-tools row). The
 * tools stay mounted even when this seat's endpoint is challenged — the
 * vendored tool contract documents exactly that state ("an enabled tool
 * remains visible when its provider is unavailable and fails with a
 * structured error at execution time"). */
export const mountWebPlane = async (ctx) => {
  log.debug('mountWebPlane', {});
  const [{ WebRuntime }, { httpFetch }] = await Promise.all([
    import('@deepseek-ai/dsh-web'),
    import('gateway.js'),
  ]);
  await ctx.plugin(WebRuntime, {});
  ctx.web.registerSearchProvider(createKeylessSearchProvider({
    httpFetch,
    decodeUtf8: (bytes) => Buffer.from(bytes).toString('utf8'),
  }));
  const toolWeb = await import('@deepseek-ai/dsh-tool-web');
  await ctx.plugin(toolWeb, { search: true, fetch: false });
};
