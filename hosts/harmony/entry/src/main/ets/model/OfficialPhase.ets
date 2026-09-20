// dsh:logging-exempt (hilog markers drive the E2E UI automation; canonical
// lines route through the phase sink via hostCarrierLine — ONE writer)
/**
 * OfficialPhase — the D9 official-web-mount drive (b-harmony.official-web-
 * mount), the harmony twin of hosts/ios OfficialWebRuntime.swift + the b1
 * half of WebBootRuntimeDrive.swift. A fresh NAPI runtime runs the canonical
 * b1-web-live scenario: the runtime composes the OFFICIAL boot wire with the
 * vendored @deepseek-ai/dsh-client-modules node half and posts `web.boot`
 * over the bus seam; the carrier swaps the rows into the index render
 * pipeline, overrides the /plugins revs, and only then opens the origin —
 * the page's facade `create()` materializes the REAL upstream browser bundle
 * (module system live) and boots the real client module system.
 *
 * With the compose-only closure there are no runtime services: /api and the
 * mux stay carrier-unimplemented (structured, loud) — the honest next named
 * gap. Evidence is carrier-side observation (single-emission: the page's
 * own traffic fires the wire hooks repeatedly; the once-guards pin the
 * honest firsts in manifest order) plus the same-origin probe through the
 * WebView (module.system.live / app.shell.rendered / page.rendered).
 *
 * Threading: every NAPI call runs on the ArkTS main thread — the ONE serial
 * JS runtime thread (ARCHITECTURE.md §6). Bus callbacks from C re-enter
 * ArkTS synchronously and only send (never re-enter the runtime).
 */
import {
  hostBusDeliver,
  hostCarrierLine,
  hostEval,
  hostEvent,
  hostFree,
  hostSettle,
  hostStart,
} from 'libspike.so';
import { common } from '@kit.AbilityKit';
import { resourceManager } from '@kit.LocalizationKit';
import { socket } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';
import { CarrierRequest, CarrierServer } from './CarrierServer';
import { WebDist, BootRow } from './WebDist';
import { WebPlugins } from './WebPlugins';
import { ApiBridge } from './ApiBridge';
import { HttpFetch } from './HttpFetch';

const TAG: string = 'dsh.app';
const OFFICIAL_BASE_PORT: number = 17890;
const SCENARIO_OFFICIAL = 'b-harmony.official-web-mount';
const SCENARIO_HTTPFETCH = 'b-harmony.httpfetch-v2';
const ENTRY_B1 = 'scenario/b1-web-live.js';
const ENTRY_HTTPFETCH = 'scenario/harmony-httpfetch-v2.js';
/** The vendored dist's entry chunk (pinned by the dist MANIFEST.sha256 —
 * the deterministic asset evidence both b1 manifests pin). */
const ENTRY_CHUNK = '/assets/index-8VXBH-f-.js';
const RECOVERY_DEFAULTS = '{"backoffBaseMs":500,"backoffFactor":2,' +
  '"backoffMaxMs":10000,"generationReadyWarnMs":3000,' +
  '"generationReadyTimeoutMs":15000}';
/** The official-phase RuntimeDescriptor: httpFetch v2 is REAL on this host
 * (the streaming body bridge, model/HttpFetch.ets) — 6 available / 3
 * unavailable. The frozen m5 phase keeps its 5/4 v1 descriptor. */
const OFFICIAL_DESCRIPTOR = '{"available":["fsRead","fsWrite","fsScope",' +
  '"notify","presentApproval","httpFetch"],' +
  '"unavailable":["presentPicker","keychainGet","keychainSet"]}';

interface BootMessage {
  rows?: Array<Record<string, string>>;
  recovery?: Record<string, number>;
  plugins?: Array<Record<string, string>>;
  graph?: Record<string, Object>;
}

interface ClaimMessage {
  endpoints?: string[];
}

interface BusMessage {
  type?: string;
  rpcId?: string;
  result?: Record<string, Object>;
  streamId?: string;
  value?: Record<string, Object>;
  code?: string;
  message?: string;
  details?: Record<string, Object>;
  endpoints?: string[];
}

interface ProbeResult {
  moduleMode?: string;
  appMounted?: boolean;
  page?: ProbePage;
}

interface ProbePage {
  boot?: boolean;
  bootText?: string;
  rootHasChild?: boolean;
}

export class OfficialPhase {
  private static instance: OfficialPhase | null = null;

  private server: CarrierServer = new CarrierServer();
  private dist: WebDist | null = null;
  private plugins: WebPlugins | null = null;
  private bridge: ApiBridge | null = null;
  private http: HttpFetch = new HttpFetch();
  private token: string = '';
  private port: number = 0;
  private capturePath: string = '';
  private started = false;
  private bootApplied = false;
  private originOpened = false;
  private finished = false;
  private comboURL = '';
  private comboPending: string | null = null;
  private assetLogged = false;
  private comboLogged = false;
  private emittedEvents: Set<string> = new Set();
  private webRoot: string = '';
  private fsRoot: string = '';
  private ctx: common.UIAbilityContext | null = null;

  /** Index wires the ArkWeb controller through these. */
  onPageEnd: () => void = (): void => {};
  openOrigin: (url: string) => void = (url: string): void => {};

  static getInstance(): OfficialPhase {
    if (OfficialPhase.instance === null) {
      OfficialPhase.instance = new OfficialPhase();
    }
    return OfficialPhase.instance;
  }

  /** Boots the whole phase: routes → listen → runtime → web.boot → origin. */
  begin(ctx: common.UIAbilityContext, webRoot: string, capturePath: string,
    fsRoot: string): void {
    this.ctx = ctx;
    this.webRoot = webRoot;
    this.capturePath = capturePath;
    this.fsRoot = fsRoot;
    this.token = OfficialPhase.randomToken();
    this.startCarrier(ctx);
  }

  private startCarrier(ctx: common.UIAbilityContext): void {
    const raw = (rel: string): Uint8Array | null => {
      try {
        return ctx.resourceManager.getRawFileContentSync('spike/' + rel);
      } catch (e) {
        return null;
      }
    };
    const dirs = ctx.resourceManager.getRawFileListSync(
      'spike/officialweb/plugins/npm/@deepseek-ai/');
    this.dist = new WebDist(this.server, raw, this.token);
    this.plugins = new WebPlugins(this.server, raw, dirs);
    this.bridge = new ApiBridge(this.server, this.token);
    this.server.registerFallback(this.dist.handler);
    this.server.register('prefix', '/plugins', this.plugins.handler);
    this.bridge.install();
    this.server.onWsFrame = (text: string, path: string): void => {
      if (this.bridge !== null) {
        this.bridge.ingestFrame(text, path);
      }
    };
    // Carrier → runtime seam: claimed /api requests and mux.open/cancel
    // deliveries ride the bus (the runtime's answers come back as
    // api.respond / mux.item|error|end posts).
    this.bridge.deliverToRuntime = (jsonText: string): void => {
      const status = hostBusDeliver(2, jsonText);
      if (status < 0) {
        hilog.error(0x0000, TAG, 'official: bus deliver failed');
      }
    };
    this.wireEvidence();
    this.server.start(OFFICIAL_BASE_PORT).then((port: number): void => {
      this.port = port;
      // hostStart FIRST: the carrier evidence lines route through the phase
      // sink (hostCarrierLine), which is only live once the runtime exists.
      this.startRuntime(ctx);
      this.carrierLine(SCENARIO_OFFICIAL, 'carrier.listening', {
        'transport': 'tcp', 'loopback': true, 'port': port,
      });
      this.carrierLine(SCENARIO_OFFICIAL, 'client.selected', {
        'client': 'dsh-web-official', 'source': 'launch',
      });
      this.evalCompose(ctx);
    }).catch((err: Error): void => {
      hilog.error(0x0000, TAG, 'official: carrier failed: %{public}s',
        err.message ?? 'unknown');
    });
  }

  /** Creates the phase runtime (sink live from here on) and wires the
   * httpFetch v2 seam; the scenario eval + the web.plugins delivery follow
   * on the same stack so the boot wire composes while the carrier holds. */
  private startRuntime(ctx: common.UIAbilityContext): void {
    hostStart(this.webRoot, this.capturePath, this.fsRoot, OFFICIAL_DESCRIPTOR,
      (line: string): void => {
        this.onBusLine(line);
      },
      (callId: number, name: string, args: string): void => {
        this.onDispatch(ctx, callId, name, args);
      }, SCENARIO_OFFICIAL);
    this.started = true;
    this.http.settle = (callId: number, ok: boolean, json: string): void => {
      const status = hostSettle(2, callId, ok, json);
      if (status < 0) {
        hilog.error(0x0000, TAG, 'official: http settle failed');
      }
    };
    this.http.emit = (json: string): void => {
      const status = hostEvent(2, json);
      if (status < 0) {
        hilog.error(0x0000, TAG, 'official: http event failed');
      }
    };
  }

  /** Evals the b1-web-live scenario and delivers the staged web-plugins
   * (the runtime composes the official boot wire and posts `web.boot`). */
  private evalCompose(ctx: common.UIAbilityContext): void {
    const status = hostEval(2, ENTRY_B1);
    if (status !== 0) {
      hilog.error(0x0000, TAG, 'official: b1 eval status %{public}d', status);
      return;
    }
    this.deliverWebPlugins(ctx);
  }

  /** The staged web-plugins delivery: every package under
   * officialweb/plugins/npm/@deepseek-ai (sorted), files base64 — the same
   * delivery contract WebBootRuntimeDrive.webPluginsDelivery() pins on iOS
   * (mtimeMs: 0, sorted directory order = the graph scan-order tie-break). */
  private deliverWebPlugins(ctx: common.UIAbilityContext): void {
    const raw = (rel: string): Uint8Array | null => {
      try {
        return ctx.resourceManager.getRawFileContentSync('spike/' + rel);
      } catch (e) {
        return null;
      }
    };
    const base64 = new util.Base64Helper();
    const dirs = ctx.resourceManager.getRawFileListSync(
      'spike/officialweb/plugins/npm/@deepseek-ai/').slice().sort();
    const plugins: string[] = [];
    for (let i = 0; i < dirs.length; i++) {
      const dirName = dirs[i];
      const at = dirName.lastIndexOf('@');
      if (at <= 0) {
        continue;
      }
      const name = '@deepseek-ai/' + dirName.substring(0, at);
      const vfsRoot = '/web-plugins/npm/@deepseek-ai/' + dirName;
      const pkg = this.fileEntry(raw, base64,
        'officialweb/plugins/npm/@deepseek-ai/' + dirName + '/package.json');
      const bundle = this.fileEntry(raw, base64,
        'officialweb/plugins/npm/@deepseek-ai/' + dirName + '/lib/client.js');
      if (pkg === null || bundle === null) {
        hilog.error(0x0000, TAG, 'official: staged package missing %{public}s',
          dirName);
        return;
      }
      const files: Record<string, Object> = {};
      files[vfsRoot + '/package.json'] = pkg;
      files[vfsRoot + '/lib/client.js'] = bundle;
      const plugin: Record<string, Object> = {
        'loaderName': name,
        'pkgJsonPath': vfsRoot + '/package.json',
        'entryPath': vfsRoot + '/lib/client.js',
        'files': files,
      };
      plugins.push(JSON.stringify(plugin));
    }
    // Assemble the (multi-megabyte) bus line without quadratic concatenation.
    const line = '{"type":"web.plugins","plugins":[' + plugins.join(',') + ']}';
    hilog.info(0x0000, TAG, 'official: delivering web.plugins (%{public}d packages, %{public}d bytes)',
      plugins.length, line.length);
    const status = hostBusDeliver(2, line);
    hilog.info(0x0000, TAG, 'official: web.plugins delivered, drive status %{public}d',
      status);
    if (status < 0) {
      hilog.error(0x0000, TAG, 'official: compose failed');
    }
  }

  private fileEntry(raw: (rel: string) => Uint8Array | null,
    base64: util.Base64Helper, rel: string): Record<string, Object> | null {
    const bytes = raw(rel);
    if (bytes === null) {
      return null;
    }
    const entry: Record<string, Object> = {
      'b64': base64.encodeToStringSync(bytes),
      'mtimeMs': 0,
    };
    return entry;
  }

  // ---- the runtime's bus posts ------------------------------------------------

  /** JS → host: web.boot / api.claim / mux.claim / api.respond / mux.*. */
  private onBusLine(line: string): void {
    let msg: BusMessage = {};
    try {
      msg = JSON.parse(line) as BusMessage;
    } catch (e) {
      return;
    }
    if (msg.type === 'web.boot') {
      this.applyWebBoot(line);
      return;
    }
    if (this.bridge === null) {
      return; // compose-only: the claims the b1 shape posts are ignored
    }
    if (msg.type === 'api.claim') {
      const claim = JSON.parse(line) as ClaimMessage;
      this.bridge.claim(claim.endpoints ?? []);
    } else if (msg.type === 'mux.claim') {
      this.bridge.claimMux();
    } else if (msg.type === 'api.respond') {
      this.bridge.respondAPI(msg.rpcId ?? '', JSON.stringify(msg.result ?? {}));
    } else if (msg.type === 'mux.item') {
      this.bridge.muxItem(msg.streamId ?? '', JSON.stringify(msg.value ?? {}));
    } else if (msg.type === 'mux.error') {
      // The compose-only runtime CLAIMS the mux (web-boot.js posts
      // mux.claim) and answers non-journal streams itself, so the first
      // open's gateway/unimplemented error RELAYS through this seam —
      // pin the services gap before the frame reaches the page.
      const details = msg.details;
      const endpoint = details !== undefined && details['endpoint'] !== undefined ?
        String(details['endpoint']) : '';
      if (endpoint.length > 0) {
        this.emitOnce(SCENARIO_OFFICIAL, 'session.services.pending', {
          'leg': endpoint,
          'reason': 'the first mux stream open was answered gateway/unimplemented; ' +
            'the web-boot closure embeds no agent spine — the session API is ' +
            'the next named gap',
        });
      }
      this.bridge.muxError(msg.streamId ?? '', msg.code ?? 'error',
        msg.message ?? '', JSON.stringify(msg.details ?? {}));
    } else if (msg.type === 'mux.end') {
      this.bridge.muxEnd(msg.streamId ?? '');
    }
  }

  /** Swaps the runtime's rows into the render pipeline, overrides the
   * /plugins revs, and opens the origin (the page load must never race the
   * boot-wire composition). */
  private applyWebBoot(line: string): void {
    const boot = JSON.parse(line) as BootMessage;
    const rows: BootRow[] = (boot.rows ?? []).map((row: Record<string, string>):
      BootRow => {
      const out: BootRow = {
        kind: row['kind'],
        name: row['name'],
        value: row['value'],
        text: row['text'],
        src: row['src'],
        placement: row['placement'],
      };
      return out;
    });
    rows.push({
      kind: 'global', name: '__DSH_CONNECTION_RECOVERY__',
      value: RECOVERY_DEFAULTS,
    });
    if (this.dist !== null) {
      this.dist.indexRows = (): BootRow[] => rows;
    }
    if (this.plugins !== null) {
      this.plugins.applyRuntimeRevs(boot.plugins ?? []);
    }
    const batches = (boot.graph ?? {})['batches'] as
      Array<Record<string, string>> | undefined;
    if (batches !== undefined && batches.length > 0) {
      this.comboURL = batches[0]['url'] ?? '';
    }
    this.bootApplied = true;
    this.emitOnce(SCENARIO_OFFICIAL, 'web.boot.applied', {
      'rows': rows.length,
      'source': 'runtime (vendored @deepseek-ai/dsh-client-modules)',
    });
    // The composed module graph, observed carrier-side (the canonical
    // scenario logs the same fact as runtime.booted under the b1 id; the
    // harmony manifest pins the harmony scenario id, so the entry list is
    // mirrored here).
    const entries = (boot.graph ?? {})['entries'] as
      Array<Record<string, string>> | undefined;
    if (entries !== undefined) {
      this.emitOnce(SCENARIO_OFFICIAL, 'runtime.composed', {
        'entries': entries.map((entry: Record<string, string>): string =>
          entry['id'] ?? ''),
        'source': 'vendored @deepseek-ai/dsh-client-modules composed in-runtime',
      });
    }
    this.maybeOpenOrigin();
  }

  private maybeOpenOrigin(): void {
    if (!this.bootApplied || this.port === 0 || this.originOpened || this.finished) {
      return;
    }
    this.originOpened = true;
    const url = 'http://127.0.0.1:' + this.port + '/?token=' + this.token;
    hilog.info(0x0000, TAG, 'official: opening origin %{public}s', url);
    this.openOrigin(url);
  }

  // ---- wire evidence (single-emission, manifest order) -------------------------

  private wireEvidence(): void {
    const dist = this.dist;
    const plugins = this.plugins;
    const bridge = this.bridge;
    if (dist === null || plugins === null || bridge === null) {
      return;
    }
    dist.onIndexRendered = (rows: number, bytes: number): void => {
      this.emit(SCENARIO_OFFICIAL, 'index.injected', { 'rows': rows, 'bytes': bytes });
    };
    dist.onIndexServed = (): void => {
      this.emit(SCENARIO_OFFICIAL, 'index.served', { 'path': '/', 'status': 200 });
    };
    dist.onAssetServed = (path: string): void => {
      this.observeAsset(path);
    };
    plugins.onComboServed = (url: string, bytes: number): void => {
      this.observeCombo(url, bytes);
    };
    bridge.onUpgradeAccepted = (path: string): void => {
      this.emitOnce(SCENARIO_OFFICIAL, 'upgrade.accepted', { 'path': path });
    };
    this.server.onSeatOpen = (path: string): void => {
      this.emitOnce(SCENARIO_OFFICIAL, 'mux.upgraded', { 'path': path });
    };
    bridge.onAPICall = (endpoint: string, answered: string): void => {
      this.emitOnce(SCENARIO_OFFICIAL, 'rpc.observed', {
        'endpoint': endpoint, 'answered': answered,
      });
    };
    bridge.onMuxOpen = (streamId: string, endpoint: string): void => {
      this.emitOnce(SCENARIO_OFFICIAL, 'session.attached', {
        'streamId': streamId, 'stream': endpoint,
      });
    };
    bridge.onMuxErrorFrame = (endpoint: string): void => {
      // Record the leg BEFORE the error frame hook fires (the observer reads
      // it synchronously inside the frame callback).
      this.emitOnce(SCENARIO_OFFICIAL, 'session.services.pending', {
        'leg': endpoint,
        'reason': 'the first mux stream open was answered gateway/unimplemented; ' +
          'the web-boot closure embeds no agent spine — the session API is ' +
          'the next named gap',
      });
    };
  }

  /** The entry chunk is the deterministic first-fetch evidence; a combo that
   * already arrived is reported here, keeping the fixed report order. Only
   * the ENTRY CHUNK is pinned: ArkWeb's fetch scheduling races the CSS and
   * other assets, so "first asset" is not deterministic — "the entry chunk
   * was served" is. */
  private observeAsset(path: string): void {
    if (this.assetLogged || path !== ENTRY_CHUNK) {
      return;
    }
    this.assetLogged = true;
    this.emit(SCENARIO_OFFICIAL, 'asset.served', { 'path': path });
    if (this.comboPending !== null && !this.comboLogged) {
      this.comboLogged = true;
      this.emit(SCENARIO_OFFICIAL, 'plugins.served', {
        'path': this.comboPending, 'bytes': this.comboPendingBytes,
      });
    }
  }

  private comboPendingBytes: number = 0;

  /** Single-emission combo report; an early arrival waits in `comboPending`
   * for the fixed report order. Only the BOOTSTRAP combo is pinned: the
   * blocking bootstrap batch is exactly @deepseek-ai/dsh-client-modules
   * (single-resource combo), fetched by the entry chunk's loader — the
   * application batches race it on ArkWeb and say nothing about the mount. */
  private observeCombo(url: string, bytes: number): void {
    if (this.comboLogged ||
      !url.startsWith(
        '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=')) {
      return;
    }
    if (!this.assetLogged) {
      this.comboPending = url;
      this.comboPendingBytes = bytes;
      return;
    }
    this.comboLogged = true;
    this.emit(SCENARIO_OFFICIAL, 'plugins.served', { 'path': url, 'bytes': bytes });
  }

  // ---- the page probe (same-origin, ArkWeb runJavaScript) -----------------------

  /** The b1 same-origin probe, harmony twin of hosts/ios OfficialWebProbe
   * (rendered-state half): defines `__b1Run`, waits for the official facade
   * to go live, then for the APPLICATION MOUNT — the boot page
   * (`[data-dsh-boot]`) disposing with a populated root is exactly the UI
   * renderer mounting the real shell. The TRUE rendered state is reported
   * as-is; the result lands in `window.__b1Out` (ArkWeb's runJavaScript does
   * not await promises, so the probe parks its JSON there and ArkTS polls
   * with a deadline). */
  static probeScript: string = `
window.__b1Out = null;
window.__b1Run = async () => {
  const out = {};
  const waitFor = async (condition, deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline && !condition()) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return condition();
  };
  out.moduleMode = window.__ModuleLoader__ ? String(window.__ModuleLoader__.mode) : 'none';
  await waitFor(
    () => window.__ModuleLoader__ && window.__ModuleLoader__.mode === 'live', 5000);
  const readBoot = () => {
    const boot = document.querySelector('[data-dsh-boot]');
    return {boot: boot !== null,
      bootText: boot ? boot.textContent.slice(0, 200) : '',
      rootHasChild: ((document.getElementById('root') || {}).childElementCount || 0) > 0};
  };
  out.page = readBoot();
  out.appMounted = await waitFor(() => {
    const state = readBoot();
    return !state.boot && state.rootHasChild;
  }, 45000);
  out.page = readBoot();
  const root = document.getElementById('root') || {};
  out.rootChildCount = root.childElementCount || 0;
  out.rootTextSample = String(root.innerText || '').slice(0, 200);
  return JSON.stringify(out);
};
window.__b1Run().then((json) => { window.__b1Out = json; })
  .catch((e) => { window.__b1Out = JSON.stringify({probeError: String(e)}); });
'probe-started';
`;

  /** The document finished loading: define the probe and start polling for
   * its result (polled condition with a deadline — rule 8). The URL gate
   * matters: a src-initiated token load commits the 303's EMPTY document
   * before the redirect lands on the clean index, and probing that document
   * would pin a false 'no module system' verdict — only the clean origin
   * (no token query) carries the injected rows. */
  onPageFinished(url: string, runJs: (script: string) => Promise<string>): void {
    if (!this.bootApplied || this.finished) {
      return;
    }
    const clean = 'http://127.0.0.1:' + this.port + '/';
    if (!url.startsWith(clean) || url.includes('token=')) {
      return;
    }
    runJs(OfficialPhase.probeScript).then((): Promise<string> => {
      return this.pollProbe(runJs, Date.now() + 90000);
    }).then((json: string): void => {
      this.consumeProbe(json);
    }).catch((err: Error): void => {
      hilog.error(0x0000, TAG, 'official: probe failed: %{public}s',
        err.message ?? 'unknown');
    });
  }

  private pollProbe(runJs: (script: string) => Promise<string>,
    deadline: number): Promise<string> {
    return runJs('JSON.stringify(window.__b1Out ?? null)').then((json: string):
      Promise<string> => {
      // runJavaScript JSON-quotes string results (observed: the read comes
      // back as "\"{\\\"moduleMode\\\"…}\""), so decode the wrapper first —
      // and accept a raw (unquoted) return as the value itself.
      let value: string | null = null;
      try {
        const decoded: Object = JSON.parse(json) as Object;
        if (typeof decoded === 'string') {
          value = decoded;
        } else if (decoded !== null && decoded !== undefined) {
          value = json;
        }
      } catch (e) {
        value = null;
      }
      if (value !== null && value.length > 0 && value !== 'null') {
        return Promise.resolve(value);
      }
      if (Date.now() > deadline) {
        return Promise.reject(new Error('probe deadline elapsed'));
      }
      return new Promise<string>((resolve: (v: string) => void): void => {
        setTimeout((): void => {
          this.pollProbe(runJs, deadline).then((v: string): void => {
            resolve(v);
          }).catch((err: Error): void => {
            hilog.error(0x0000, TAG, 'official: poll failed: %{public}s', err.message ?? '');
          });
        }, 300);
      });
    });
  }

  private consumeProbe(json: string): void {
    if (this.finished) {
      return;
    }
    hilog.info(0x0000, TAG, 'official: probe raw %{public}s', json.substring(0, 120));
    let parsed: Object;
    try {
      parsed = JSON.parse(json) as Object;
      // runJavaScript may hand the probe JSON back quoted one extra time
      // (the value arrives as a JSON string literal) — unwrap that layer.
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed as string) as Object;
      }
    } catch (e) {
      hilog.error(0x0000, TAG, 'official: probe unparsable: %{public}s',
        json.substring(0, 200));
      return;
    }
    const probe = parsed as ProbeResult;
    const page = probe.page ?? {};
    const moduleMode = probe.moduleMode ?? 'none';
    const appMounted = probe.appMounted === true;
    this.emit(SCENARIO_OFFICIAL, 'module.system.live', {
      'mode': moduleMode,
      'bootstrap': '@deepseek-ai/dsh-client-modules (vendored)',
    });
    this.emit(SCENARIO_OFFICIAL, 'app.shell.rendered', {
      'mounted': appMounted,
      'rootHasChild': page.rootHasChild === true,
      'bootPageDisposed': page.boot === false,
    });
    this.emit(SCENARIO_OFFICIAL, 'page.rendered', {
      'boot': page.boot === true,
      'rootHasChild': page.rootHasChild === true,
      'moduleMode': moduleMode,
    });
    this.finished = true;
    this.carrierLine(SCENARIO_OFFICIAL, 'mount.complete', {
      'status': appMounted && moduleMode === 'live' ? 'pass' : 'partial',
    });
    // The httpFetch proof leg rides a FRESH runtime after the mount (the
    // b1 scenario latched its verdict; a new hostStart gets clean verdict
    // state) — deferred to a later tick off any NAPI call stack.
    const phase = this;
    setTimeout((): void => {
      if (phase.ctx !== null) {
        phase.runHttpFetchLeg(phase.ctx);
      }
    }, 200);
  }

  // ---- gateway dispatch (httpFetch v2) ---------------------------------------------

  private onDispatch(ctx: common.UIAbilityContext, callId: number,
    name: string, args: string): void {
    hilog.info(0x0000, TAG, 'official: dispatch %{public}s call=%{public}d',
      name, callId);
    if (name === 'httpFetch') {
      this.http.fetch(callId, args);
      return;
    }
    if (name === 'httpFetch.abort') {
      this.http.abort(args);
      return;
    }
    // The official-web legs never touch notify/approval; anything else here
    // is a wiring bug — fail loud through a structured rejection.
    const status = hostSettle(2, callId, false,
      '{"code":"invalid","primitive":' + JSON.stringify(name) +
      ',"message":"not forwarded"}');
    if (status < 0) {
      hilog.error(0x0000, TAG, 'official: reject settle failed');
    }
  }

  // ---- the httpFetch proof leg -------------------------------------------------------

  /** After the mount completes: a fresh runtime runs the harmony httpFetch
   * v2 scenario against the LIVE carrier (the platform gap flip, proven
   * on-device). Its scenario id keeps the capture filterable. */
  runHttpFetchLeg(ctx: common.UIAbilityContext): void {
    if (!this.started) {
      return;
    }
    hostFree(2);
    this.started = false;
    const capturePath = this.capturePath.replace('official', 'httpfetch');
    hostStart(this.webRoot, capturePath, this.fsRoot, OFFICIAL_DESCRIPTOR,
      (line: string): void => {
        this.onBusLine(line);
      },
      (callId: number, name: string, args: string): void => {
        this.onDispatch(ctx, callId, name, args);
      }, SCENARIO_HTTPFETCH);
    this.started = true;
    const status = hostEval(2, ENTRY_HTTPFETCH);
    hilog.info(0x0000, TAG, 'httpfetch leg: eval status %{public}d', status);
    this.deliverEvent('{"event":"host.info","port":' + this.port + '}');
  }

  // ---- plumbing ------------------------------------------------------------------

  private deliverEvent(eventJson: string): void {
    if (!this.started) {
      return;
    }
    const status = hostEvent(2, eventJson);
    if (status < 0) {
      hilog.error(0x0000, TAG, 'official: event failed: %{public}s', eventJson);
    }
  }

  destroy(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    hostFree(2);
    this.server.stop();
  }

  private emit(scenario: string, event: string,
    fields: Record<string, Object>): void {
    this.carrierLine(scenario, event, fields);
  }

  private emitOnce(scenario: string, event: string,
    fields: Record<string, Object>): void {
    if (this.emittedEvents.has(event)) {
      return;
    }
    this.emittedEvents.add(event);
    this.carrierLine(scenario, event, fields);
  }

  /** One canonical carrier-side evidence line through the phase sink: the
   * SAME `dsh.spike.log:` envelope the JS logger emits (the checker's
   * extract prefix), routed host→sink for hilog + capture. */
  private carrierLine(scenario: string, event: string,
    fields: Record<string, Object>): void {
    const payload: Record<string, Object> = {
      'scenario': scenario,
      'event': event,
    };
    const keys: string[] = Object.keys(fields);
    for (let i = 0; i < keys.length; i++) {
      payload[keys[i]] = fields[keys[i]];
    }
    const data: Object[] = [payload];
    const envelope: Record<string, Object> = {
      'level': 'info',
      'module': 'dsh.carrier',
      'message': 'e2e',
      'data': data,
    };
    hostCarrierLine(2, 'dsh.spike.log: ' + JSON.stringify(envelope));
  }

  static randomToken(): string {
    let out = '';
    for (let i = 0; i < 32; i++) {
      out += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
    }
    return out;
  }
}
