// dsh:logging-exempt (fallback seat: evidence rides the phase sink)
/**
 * WebDist — the fallback seat for the OFFICIAL upstream dist, the
 * frontend-static behavior of docs/webserver-contract.md §2.1 with the
 * Phase-B adaptations of §3.4/§3.6: GET/HEAD only (405 otherwise), traversal
 * → 403, fixed MIME table (+ fonts/png), empty 404s, the auth-lite
 * token→cookie exchange gating index responses only, and the index render
 * pipeline (§1.5): head rows after `<head…>`, body rows after `<body…>`, the
 * `__DSH_BOOT_READY__` tail last, then `<base href="/">`.
 *
 * The dist bytes come straight from rawfile (`spike/officialweb/www/…` —
 * vendored verbatim by ci/vendor-official.sh); no disk staging.
 */
import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { CarrierRequest, CarrierServer, COOKIE_NAME } from './CarrierServer';

/** One structured index-injection row (upstream `IndexInjection`, §1.5).
 * `global` values arrive pre-encoded (the runtime's serializeRows splices
 * raw JSON text with `<` escaped). */
export interface BootRow {
  kind?: string;
  placement?: string;
  name?: string;
  value?: string;
  text?: string;
  src?: string;
}

const MIME: Map<string, string> = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['svg', 'image/svg+xml'],
  ['json', 'application/json'],
  ['map', 'application/json'],
  ['webmanifest', 'application/manifest+json'],
  ['gz', 'application/gzip'],
  ['woff2', 'font/woff2'],
  ['woff', 'font/woff'],
  ['ttf', 'font/ttf'],
  ['png', 'image/png'],
]);

export class WebDist {
  /** Evidence hooks — the owning drive logs them; the seat never logs. */
  onIndexRendered: (rows: number, bytes: number) => void =
    (rows: number, bytes: number): void => {};
  onIndexServed: () => void = (): void => {};
  onAssetServed: (path: string) => void = (path: string): void => {};

  /** Boot rows, read fresh per render (§1.5: live rows per render). */
  indexRows: () => BootRow[] = (): BootRow[] => [];
  private server: CarrierServer;
  private rawfile: (rel: string) => Uint8Array | null;
  private sessionToken: string;

  constructor(server: CarrierServer, rawfile: (rel: string) => Uint8Array | null,
    sessionToken: string) {
    this.server = server;
    this.rawfile = rawfile;
    this.sessionToken = sessionToken;
  }

  handler = (req: CarrierRequest, conn: socket.TCPSocketConnection): void => {
    this.serve(req, conn);
  };

  private serve(req: CarrierRequest, conn: socket.TCPSocketConnection): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.empty(conn, 405); // named routes own their methods
      return;
    }
    if (req.path === null) {
      this.empty(conn, 400);
      return;
    }
    if (req.path.includes('..')) {
      this.empty(conn, 403);
      return;
    }
    const indexBytes = this.rawfile('officialweb/www/index.html');
    if (req.path === '/' || (req.path === '/index.html' && indexBytes !== null)) {
      this.serveIndex(req, conn);
      return;
    }
    this.serveAsset(req, conn);
  }

  // ---- index (auth-lite + render pipeline) --------------------------------

  private serveIndex(req: CarrierRequest, conn: socket.TCPSocketConnection): void {
    if (req.method === 'GET' && req.query !== null &&
      req.query.includes('token=' + this.sessionToken)) {
      // mint the session cookie, then bounce to the clean URL (§2.2/§3.4)
      const extra: Record<string, string> = {
        'Set-Cookie': COOKIE_NAME + '=' + this.sessionToken +
          '; Path=/; HttpOnly',
        'Location': '/',
      };
      this.respond(conn, 303, 'text/plain', '', extra, false);
      return;
    }
    if (!this.isAuthed(req)) {
      this.empty(conn, 401);
      return;
    }
    const raw = this.rawfile('officialweb/www/index.html');
    if (raw === null) {
      this.empty(conn, 404);
      return;
    }
    const rows = this.indexRows();
    const rendered = WebDist.renderIndex(WebDist.bytesToText(raw), rows);
    this.onIndexRendered(rows.length, WebDist.utf8Count(rendered));
    this.onIndexServed();
    this.server.respond(conn, 200, 'text/html; charset=utf-8',
      WebDist.textToBytes(rendered), {}, req.method === 'HEAD');
  }

  /** Whether the request carries the valid session token (cookie first,
   * token query parameter second — the WebView hands the token once). */
  private isAuthed(req: CarrierRequest): boolean {
    return WebDist.isAuthedFor(req, this.sessionToken);
  }

  /** The shared auth-lite check (the /api + mux seats reuse it verbatim). */
  static isAuthedFor(req: CarrierRequest, token: string): boolean {
    const cookie = req.headers['cookie'] ?? '';
    const pairs = cookie.split(';');
    for (let i = 0; i < pairs.length; i++) {
      const at = pairs[i].indexOf('=');
      if (at > 0 && pairs[i].substring(0, at).trim() === COOKIE_NAME &&
        pairs[i].substring(at + 1).trim() === token) {
        return true;
      }
    }
    return req.query !== null && req.query.includes('token=' + token);
  }

  /** Renders rows into the raw index body: head rows after the opening head
   * tag, body rows after the opening body tag, the boot-readiness tail after
   * the last body row (upstream `renderIndexInjections`), then the
   * `<base href="/">` transform immediately after `<head…>` (upstream
   * frontend-static: base lands before the spliced row markup). */
  static renderIndex(html: string, rows: BootRow[]): string {
    let head = '';
    let body = '';
    for (let i = 0; i < rows.length; i++) {
      const row = WebDist.renderRow(rows[i]);
      if (row.placement === 'head') {
        head += row.markup;
      } else {
        body += row.markup;
      }
    }
    body += WebDist.readyMarkup;
    let out = WebDist.spliceAfter(html, '<head', '<base href="/">' + head);
    out = WebDist.spliceAfter(out, '<body', body);
    return out;
  }

  /** The tail script settling `__DSH_BOOT_READY__` (upstream READY_MARKUP). */
  static readyMarkup: string =
    '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>';

  /** The settings dialog's phone adaptation, injected as a §1.5 `style` row
   * into every official-page render. Upstream's SettingsRoot panel is a
   * fixed 800px desktop modal with a 188px side nav and no narrow layout,
   * so on a phone it arrived as a ~342pt modal squeezed against the screen
   * edge — the owner complaint this patch answers (the main screen needs no
   * help: the AppFrame measures its own width and drops the sidebar below
   * 1024). Two tiers, mirroring upstream's own responsive conventions:
   * ≤1024 (the app frame's auto-collapse width) near-full-bleed, ≤560 (the
   * narrow tweak settings-models ships) full-bleed with the nav flipped
   * into a horizontal chip row. The scope hook is STRUCTURAL, never the
   * hash classes (they change on upstream re-pins): the settings panel is
   * the served page's only `role=dialog` element carrying `aria-modal` AND
   * `aria-labelledby` — the attachment lightbox and the shell's dialog use
   * `aria-label` instead (verified across the pinned dist and every client
   * bundle). Cascade safety: the selector is specificity (0,3,0) and beats
   * the bundle's hash classes (0,1,0) no matter which <style> lands first,
   * while inline styles still win. Kept verbatim in step with the iOS
   * sibling (CarrierBootConfig.settingsPhoneCSS) and the Android sibling
   * (CarrierIndexRows.SETTINGS_PHONE_CSS). */
  static settingsPhoneCss: string = '@media (max-width:1024px){' +
    'div[role="dialog"][aria-modal="true"][aria-labelledby]' +
    '{width:min(calc(100vw - 24px),800px);max-width:calc(100vw - 24px);' +
    'height:min(calc(100vh - 24px),800px);border-radius:20px}} ' +
    '@media (max-width:560px){' +
    'div[role="dialog"][aria-modal="true"][aria-labelledby] ' +
    '{width:100vw;max-width:100vw;height:100vh;border-radius:0;' +
    'flex-direction:column} ' +
    'div[role="dialog"][aria-modal="true"][aria-labelledby]>nav ' +
    '{flex-direction:row;align-items:center;gap:12px;width:auto;max-width:100%;' +
    'padding:10px 12px 0} ' +
    'div[role="dialog"][aria-modal="true"][aria-labelledby]>nav>div:first-child ' +
    '{flex:none;padding:0;white-space:nowrap} ' +
    'div[role="dialog"][aria-modal="true"][aria-labelledby]>nav>div:last-child ' +
    '{flex-direction:row;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden; ' +
    'padding-bottom:8px} ' +
    'div[role="dialog"][aria-modal="true"][aria-labelledby] nav button ' +
    '{flex:none;height:36px;padding:6px 12px;white-space:nowrap} }';

  /** The `style` row every official-page render carries (OfficialServe
   * pushes it beside the runtime's rows). */
  static settingsPhoneAdaptation: BootRow = {
    kind: 'style', text: WebDist.settingsPhoneCss,
  };

  static renderRow(row: BootRow): PlacementMarkup {
    if (row.kind === 'global' && row.name !== undefined && row.value !== undefined) {
      // The name rides a QUOTED member expression (a bare identifier that
      // HTML-escaped would read as a variable reference and throw).
      const quoted = '"' + WebDist.jsEscape(row.name) + '"';
      return { placement: 'head',
        markup: '<script>globalThis[' + quoted + '] = ' + row.value + '</script>' };
    }
    if (row.kind === 'script' && row.text !== undefined) {
      return { placement: row.placement ?? 'head',
        markup: '<script>' + row.text + '</script>' };
    }
    if (row.kind === 'script-src' && row.src !== undefined) {
      return { placement: row.placement ?? 'head',
        markup: '<script src="' + WebDist.attrEscape(row.src) + '"></script>' };
    }
    if (row.kind === 'script-preload' && row.src !== undefined) {
      return { placement: 'head',
        markup: '<link rel="preload" as="script" href="' +
          WebDist.attrEscape(row.src) + '">' };
    }
    if (row.kind === 'style' && row.text !== undefined) {
      return { placement: 'head', markup: '<style>' + row.text + '</style>' };
    }
    // A KNOWN kind with a missing field keeps the page's tolerance of absent
    // optional rows (upstream emits theme/preview rows the page is fine
    // without). An UNKNOWN kind is contract drift (docs/webserver-contract.md
    // §1.5 names the row kinds) — fail loud with the offending name
    // (rules.md rule 5), never a silent skip.
    if (row.kind !== 'global' && row.kind !== 'script' && row.kind !== 'script-src' &&
      row.kind !== 'script-preload' && row.kind !== 'style') {
      throw new Error('webDist: unknown boot row kind: ' + (row.kind ?? '(none)'));
    }
    return { placement: 'head', markup: '' };
  }

  /** Inserts `markup` after the opening tag that starts with `pattern`
   * (`<head…>` / `<body…>`); prepend when the document lacks the tag. */
  static spliceAfter(html: string, pattern: string, markup: string): string {
    const at = html.indexOf(pattern + '>');
    if (at < 0) {
      const loose = html.toLowerCase().indexOf(pattern);
      if (loose < 0) {
        return markup + html;
      }
      return html.substring(0, loose + pattern.length) + markup +
        html.substring(loose + pattern.length);
    }
    return html.substring(0, at + pattern.length + 1) + markup +
      html.substring(at + pattern.length + 1);
  }

  static jsEscape(value: string): string {
    return value.split('\\').join('\\\\').split('"').join('\\"');
  }

  /** Escape one value before placing it in a quoted HTML attribute
   * (upstream `escapeHtmlAttribute`). */
  static attrEscape(value: string): string {
    return value.split('&').join('&amp;').split('"').join('&quot;')
      .split('<').join('&lt;').split('>').join('&gt;');
  }

  // ---- assets (§2.1 fixed MIME table + §3.6 fonts/png) ----------------------

  private serveAsset(req: CarrierRequest, conn: socket.TCPSocketConnection): void {
    const path = req.path ?? '';
    const dot = path.lastIndexOf('.');
    const ext = dot >= 0 ? path.substring(dot + 1).toLowerCase() : '';
    const contentType = MIME.get(ext) ?? 'application/octet-stream';
    const raw = this.rawfile('officialweb/www' + path);
    if (raw === null) {
      this.empty(conn, 404); // absent or non-file: empty 404
      return;
    }
    this.onAssetServed(path);
    this.server.respond(conn, 200, contentType,
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
      {}, req.method === 'HEAD');
  }

  private empty(conn: socket.TCPSocketConnection, status: number): void {
    this.respond(conn, status, 'text/plain', '', {}, false);
  }

  private respond(conn: socket.TCPSocketConnection, status: number, type: string,
    text: string, extra: Record<string, string>, bodyless: boolean): void {
    this.server.respond(conn, status, type, WebDist.textToBytes(text), extra,
      bodyless);
  }

  // ---- byte/text helpers ----------------------------------------------------

  static utf8Count(text: string): number {
    return WebDist.textToBytes(text).byteLength;
  }

  static bytesToText(bytes: Uint8Array): string {
    const decoder = util.TextDecoder.create('utf-8');
    return decoder.decodeToString(bytes);
  }

  static textToBytes(text: string): ArrayBuffer {
    if (text.length === 0) {
      return new ArrayBuffer(0); // encodeInto('') returns undefined on this SDK
    }
    const encoder = util.TextEncoder.create('utf-8');
    return encoder.encodeInto(text).buffer as ArrayBuffer;
  }
}

interface PlacementMarkup {
  placement: string;
  markup: string;
}
