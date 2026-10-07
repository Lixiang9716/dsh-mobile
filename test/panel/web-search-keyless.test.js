import { describe, it, expect } from 'vitest';
import {
  parseDuckDuckGoHtml,
  resolveResultHref,
  isChallengePage,
  hasResultsListDom,
  hasNoResultsDom,
  resolveSearchConfig,
  createKeylessSearchProvider,
  webSearchError,
  DEFAULT_SEARCH_ENDPOINT,
  PROVIDER_ID,
  CODE_CHALLENGED,
  CODE_STATUS,
  CODE_UNREACHABLE,
  CODE_CONFIG,
} from '../../runtime/dsh/upstream/web-search-keyless.js';

// A fixed sample of the DuckDuckGo HTML results page (html.duckduckgo.com/
// html/?q=…): the result__a title anchors wrapped in the /l/?uddg= redirect,
// the result__snippet anchors that follow them, entity-encoded text, inline
// <b> highlights, a title-only row, a duplicate URL, and neighbours that are
// NOT results (nav links, an image anchor).
const RESULTS_HTML = `<!DOCTYPE html>
<html><head><title>q at DuckDuckGo</title></head><body>
<div class="nav-link"><a href="//duckduckgo.com/?q=quickjs&amp&amp;ia=web">next</a></div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fquickjs-ng.github.io%2F&amp;rut=aa11">quickjs&#x2F;ng &#8212; the embeddable <b>js</b> engine</a>
    </h2>
    <div class="result__extras"><a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fquickjs-ng.github.io%2F&amp;rut=aa11">quickjs-ng.github.io</a></div>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fquickjs-ng.github.io%2F&amp;rut=aa11">A fork of <b>quickjs</b> that keeps improving &amp;quot;engine&amp;quot; internals &#x27;with&#39; modern C.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://bellard.org/quickjs/">Bellard &amp;lt;quickjs&amp;gt; original</a>
    </h2>
    <a class="result__snippet" href="https://bellard.org/quickjs/">Small and complete ES2023 implementation.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbellard.org%2Fquickjs%2F&amp;rut=bb22">Bellard quickjs (cache hit)</a>
    </h2>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=%ZZbad%2Fescape&amp;rut=cc33">broken escape row</a>
    </h2>
  </div>
</div>
<img src="x"><a class="job-inline" href="https://ads.example.com/">sponsored</a>
</body></html>`;

// The lite endpoint's spelling: result-link / result-snippet classes.
const LITE_HTML = `<table><tr>
  <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example%2Fone&amp;rut=dd44" class='result-link'>Lite result one</a></td>
  <td class='result-snippet'>First lite snippet</td>
</tr></table>`;

const CHALLENGE_HTML = '<html><body>Unfortunately, bots use DuckDuckGo too. Please complete the following challenge to confirm this search was made by a human.</body></html>';

// DDG's GENUINE no-results answer for a zero-hit query (live-measured
// 2026-10-04 off html.duckduckgo.com, issue #346 grounding): no result__a
// anywhere, but its own no-results structure — span.no-results inside
// .no-results__container with the "No results found for" heading — wrapped
// in the usual links chrome. An empty success here is the honest answer.
const NO_RESULTS_HTML = `<!DOCTYPE html>
<html><head><title>q at DuckDuckGo</title></head><body>
<div class="serp__results">
<div class="result results_links results_links_deep web-result result--no-result">
  <div class="links_main links_deep result__body">
    <div class="no-results__container result__title"><span class='no-results'>
      <div class="no-results__message">
        <h1>No results found for <strong>&quot;zxqjwvbkmpffdsghtruyi&quot;</strong></h1>
        <p><strong>Suggestions</strong>:<ul><li>Check spelling</li><li>Try related keywords</li></ul></p>
      </div>
    </span></div>
  </div>
</div>
</div>
</body></html>`;

// The challenge VARIANT the device battery drew (issue #346): DDG's
// anomaly-modal interstitial served as HTTP 200 WITHOUT the "bots use
// DuckDuckGo" marker sentence — the anomaly/feedback chrome, zero result
// anchors, and neither the results list nor the no-results structure. The
// old parser read this shape as a zero-source SUCCESS (the model then
// reported "no news" where the truth was "blocked"); it must fail with
// CODE_CHALLENGED and carry a page sample in the message.
const CHALLENGE_VARIANT_HTML = `<!DOCTYPE html>
<html><head><title>One more thing</title></head><body>
<div class="anomaly-modal__box">
  <h2 class="anomaly-modal__title">Please complete the puzzle before continuing</h2>
  <form class="anomaly-modal__puzzle" method="post">
    <div class="anomaly-modal__check"></div>
    <img class="anomaly-modal__image" src="/anomaly.js?p=image">
    <button class="btn btn--primary anomaly-modal__submit js-anomaly-modal-submit" type="submit">Continue</button>
  </form>
</div>
<div class="feedback-content"><p class="feedback-text">This check helps us throttle abusive automated traffic.</p></div>
</body></html>`;

const decodeUtf8 = (chunks) => new TextDecoder().decode(
  Uint8Array.from(chunks.reduce((acc, c) => [...acc, ...c], [])));

const bodyOf = (text) => ({
  status: 200,
  body: (async function* () { yield new TextEncoder().encode(text); })(),
});

describe('web-search-keyless: the DDG HTML parser (fixed sample → structured results)', () => {
  it('parses title/url/snippet rows in document order, uddg-decoded', () => {
    const { sources, truncated } = parseDuckDuckGoHtml(RESULTS_HTML);
    expect(truncated).toBe(false);
    expect(sources[0]).toEqual({
      url: 'https://quickjs-ng.github.io/',
      title: 'quickjs/ng — the embeddable js engine',
      snippet: 'A fork of quickjs that keeps improving "engine" internals \'with\' modern C.',
    });
    expect(sources[1]).toEqual({
      url: 'https://bellard.org/quickjs/',
      title: 'Bellard <quickjs> original',
      snippet: 'Small and complete ES2023 implementation.',
    });
  });

  it('drops redirect-wrapped duplicates, malformed escapes, and non-result anchors', () => {
    const { sources } = parseDuckDuckGoHtml(RESULTS_HTML);
    const urls = sources.map((s) => s.url);
    expect(urls).toEqual(['https://quickjs-ng.github.io/', 'https://bellard.org/quickjs/']);
  });

  it('keeps a title-only row without inventing a snippet', () => {
    const html = `<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsolo.example%2F">solo</a></div>`;
    const { sources } = parseDuckDuckGoHtml(html);
    expect(sources).toEqual([{ url: 'https://solo.example/', title: 'solo' }]);
  });

  it('answers the lite endpoint spelling (result-link/result-snippet)', () => {
    const { sources } = parseDuckDuckGoHtml(LITE_HTML);
    expect(sources).toEqual([{
      url: 'https://lite.example/one',
      title: 'Lite result one',
      snippet: 'First lite snippet',
    }]);
  });

  it("answers DDG's genuine no-results page with a legal empty success", () => {
    // Zero hits on a real search answer: the no-results structure, not a
    // block page — the tool answers empty and the formatter renders
    // "No results found."
    expect(parseDuckDuckGoHtml(NO_RESULTS_HTML)).toEqual({ sources: [], truncated: false });
  });
});

describe('web-search-keyless: href + challenge helpers', () => {
  it('resolves uddg redirects, direct and protocol-relative hrefs; junk is null', () => {
    expect(resolveResultHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fx&rut=z')).toBe('https://a.example/x');
    expect(resolveResultHref('https://direct.example/')).toBe('https://direct.example/');
    expect(resolveResultHref('//hostless.example/path')).toBe('https://hostless.example/path');
    expect(resolveResultHref('//duckduckgo.com/l/?uddg=%ZZ&rut=z')).toBeNull();
    expect(resolveResultHref('javascript:void(0)')).toBeNull();
    expect(resolveResultHref(undefined)).toBeNull();
  });

  it('spots the anti-bot challenge page text', () => {
    expect(isChallengePage(CHALLENGE_HTML)).toBe(true);
    expect(isChallengePage(RESULTS_HTML)).toBe(false);
    expect(isChallengePage(undefined)).toBe(false);
  });

  it('the marker misses the 200-served variant — the structural shape is what catches it', () => {
    expect(isChallengePage(CHALLENGE_VARIANT_HTML)).toBe(false);
    expect(hasResultsListDom(RESULTS_HTML)).toBe(true);
    expect(hasResultsListDom(NO_RESULTS_HTML)).toBe(true); // it wears the links chrome
    expect(hasNoResultsDom(NO_RESULTS_HTML)).toBe(true);
    expect(hasResultsListDom(CHALLENGE_VARIANT_HTML)).toBe(false);
    expect(hasNoResultsDom(CHALLENGE_VARIANT_HTML)).toBe(false);
  });

  it('a marker-less challenge variant fails in-band: zero anchors, neither results nor no-results DOM (#346)', () => {
    const call = () => parseDuckDuckGoHtml(CHALLENGE_VARIANT_HTML);
    expect(call).toThrowError(expect.objectContaining({ name: 'WebError', code: CODE_CHALLENGED }));
    // The truncated page sample rides the message — the trajectory shows
    // the block page, not a bare "no results".
    expect(call).toThrow(/anomaly-modal__title/);
    expect(call).toThrow(/__dshWebSearch\.endpoint/);
  });

  it('the code rides the MESSAGE text too — the tool-result surface a model sees is text-only (loop-n)', () => {
    const call = () => parseDuckDuckGoHtml(CHALLENGE_VARIANT_HTML);
    expect(call).toThrow(/^\[WEB_SEARCH_KEYLESS_CHALLENGED\] /);
    expect(call).toThrow(/WEB_SEARCH_KEYLESS_CHALLENGED.*anomaly-modal__title/s);
  });

  it('a page with the results-list DOM but zero anchors stays an honest empty success', () => {
    expect(parseDuckDuckGoHtml('<div class="serp__results"><div id="links"></div></div>'))
      .toEqual({ sources: [], truncated: false });
  });
});

describe('web-search-keyless: config resolution (the marketplaceIndex opt-in shape)', () => {
  it('defaults to the public endpoint with no seat config', () => {
    expect(resolveSearchConfig(undefined, undefined).endpoint).toBe(DEFAULT_SEARCH_ENDPOINT);
  });

  it('the host declaration wins over the launch environment', () => {
    expect(resolveSearchConfig({ endpoint: 'https://mirror.example/html/' }, { DSH_WEB_SEARCH_ENDPOINT: 'https://env.example/' }).endpoint)
      .toBe('https://mirror.example/html/');
    expect(resolveSearchConfig(undefined, { DSH_WEB_SEARCH_ENDPOINT: 'https://env.example/' }).endpoint)
      .toBe('https://env.example/');
  });

  it('a non-string endpoint fails loud with the config code (rule 5)', () => {
    expect(() => resolveSearchConfig({ endpoint: 42 }, undefined)).toThrowError(expect.objectContaining({ code: CODE_CONFIG }));
  });
});

const makeProvider = (impl, config) => createKeylessSearchProvider({
  httpFetch: impl,
  decodeUtf8,
  ...(config ? { config } : {}),
});

describe('web-search-keyless: the provider, success legs', () => {
  it('carries the seam contract: id, available() without network', () => {
    const provider = makeProvider(() => { throw new Error('must not dial'); });
    expect(provider.id).toBe(PROVIDER_ID);
    expect(provider.available()).toBe(true);
  });

  it('a successful search parses into the seam shape', async () => {
    let asked;
    const provider = makeProvider(async (url) => {
      asked = url;
      return bodyOf(RESULTS_HTML);
    });
    const result = await provider.search({ query: 'quickjs ng', maxResults: 8 });
    expect(asked).toBe(`${DEFAULT_SEARCH_ENDPOINT}?q=quickjs%20ng`);
    expect(result.truncated).toBe(false);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].title).toContain('quickjs/ng');
  });

});

describe('web-search-keyless: the provider, in-band failure legs', () => {
  it('a challenge answer fails in-band with the challenge code, naming the escape hatch', async () => {
    const provider = makeProvider(async () => ({ status: 202, body: bodyOf(CHALLENGE_HTML).body }));
    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({
      name: 'WebError',
      code: CODE_CHALLENGED,
    });
    await expect(provider.search({ query: 'x' })).rejects.toThrow(/__dshWebSearch.endpoint/);
  });

  it('regression #346: the 200-served marker-less variant fails in-band, never a silent-empty success', async () => {
    const provider = makeProvider(async () => bodyOf(CHALLENGE_VARIANT_HTML));
    await expect(provider.search({ query: 'DeepSeek latest news' })).rejects.toMatchObject({
      name: 'WebError',
      code: CODE_CHALLENGED,
    });
    await expect(provider.search({ query: 'DeepSeek latest news' })).rejects.toThrow(/page sample/);
  });

  it('a non-2xx answer fails in-band with the status code', async () => {
    const provider = makeProvider(async () => ({ status: 503, body: bodyOf('<html>down</html>').body }));
    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({ code: CODE_STATUS });
  });

  it('no-config in-band behavior: a dead transport surfaces the unreachable code with guidance', async () => {
    const provider = makeProvider(async () => { throw new Error('gateway offline'); });
    await expect(provider.search({ query: 'x' })).rejects.toThrow(
      /keyless endpoint could not be reached \(gateway offline\)/);
    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({ code: CODE_UNREACHABLE });
  });

  it('a non-http endpoint is rejected at construction (fail loud, not at first search)', () => {
    expect(() => createKeylessSearchProvider({
      httpFetch: async () => bodyOf(''),
      decodeUtf8,
      config: { endpoint: 'ftp://nope/' },
    })).toThrowError(expect.objectContaining({ code: CODE_CONFIG }));
  });

  it('a signal already aborted fails before dialing', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = makeProvider(async () => { throw new Error('must not dial'); });
    await expect(provider.search({ query: 'x' }, controller.signal))
      .rejects.toMatchObject({ code: CODE_UNREACHABLE });
  });
});

describe('web-search-keyless: the coded error shape', () => {
  it('is a plain Error carrying the WebError name + machine-routable code', () => {
    const err = webSearchError(CODE_CHALLENGED, 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WebError');
    expect(err.code).toBe(CODE_CHALLENGED);
    // loop-n: the code rides the MESSAGE too — the tool-result surface a
    // model or battery sees is text-only.
    expect(err.message).toBe(`[${CODE_CHALLENGED}] boom`);
  });
});
