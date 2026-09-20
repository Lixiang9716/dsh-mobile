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
 * THREE legs chain on ONE carrier (each on a FRESH runtime; per-leg
 * evidence state keeps every capture file holding exactly its own
 * manifest's records): the official mount (b1), the httpFetch v2 proof,
 * and the session-live leg (W-HARMONY3): the FULL spine boots in the
 * session-live runtime, `session.list` + the mux `session/journal` streams
 * are CLAIMED and answered from ctx.sessions (the scripted
 * /mock-llm/chat/completions endpoint is the model boundary — real
 * transport, scripted output), and the b3 probe drives the read path
 * through the official envelope (SessionLiveProbe.ets). A passing
 * session-live leg chains into the FOURTH leg, the session WRITE surface
 * (W-HARMONY4, b-harmony.write.live): the web-boot runtime composes WITH
 * upstream/web-write.js, and the write probe drives the OFFICIAL composer
 * like a user — the page's own message admits a REAL upstream agent-loop
 * turn, streamed live over the mux session/follow and rendered in the
 * official UI (SessionWriteProbe.ets).
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
  hostStatus,
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
import { SessionLiveProbe, LegEvent } from './SessionLiveProbe';
import { SessionWriteProbe, WriteVerdict, WriteLegEvent, WRITE_MESSAGE } from './SessionWriteProbe';

const TAG: string = 'dsh.app';
const OFFICIAL_BASE_PORT: number = 17890;
const SCENARIO_OFFICIAL = 'b-harmony.official-web-mount';
const SCENARIO_HTTPFETCH = 'b-harmony.httpfetch-v2';
/** The session-live leg (W-HARMONY3): the FULL spine boots in a fresh
 * runtime, session.list + the mux journal are CLAIMED and answered from
 * ctx.sessions. */
const SCENARIO_SESSION = 'b-harmony.session.live';
/** The write leg (W-HARMONY4): the web-boot runtime composes WITH the write
 * surface (upstream/web-write.js) — the official composer send
 * (`POST /api/session/prompt`) admits a REAL upstream agent-loop turn and the
 * reply streams live over the mux session/follow into the official UI. */
const SCENARIO_WRITE = 'b-harmony.write.live';
const ENTRY_B1 = 'scenario/b1-web-live.js';
const ENTRY_HTTPFETCH = 'scenario/harmony-httpfetch-v2.js';
const ENTRY_SESSION = 'scenario/harmony-session-live.js';
const ENTRY_WRITE = 'scenario/harmony-write-live.js';
/** The SCRIPTED model boundary of the session-live leg (the platform twin
 * of iOS CarrierRoutes.registerScriptedLlm): a real loopback HTTP + SSE
 * endpoint mirroring the vendored dsh-llm-mock-server's success stream
 * byte-for-byte. Real transport, scripted model — logged as such. */
const MOCK_LLM_PATH = '/mock-llm/chat/completions';
const MOCK_LLM_KEY = 'mock-key-0001';
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
  /** The session-live leg state: `legScenario` labels every canonical line
   * (each leg's capture file holds exactly its own manifest's records);
   * `spineLeg` switches the per-endpoint rpc.observed guards and the
   * boot-wire source labels on. */
  private legScenario: string = SCENARIO_OFFICIAL;
  private spineLeg = false;
  private writeLeg = false;
  private rpcLogged: Set<string> = new Set();
  private journalAttachLogged = false;
  private respondLogged = false;
  private frameLogged = false;
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
    this.registerScriptedLlm();
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
   * (mtimeMs: 0, sorted directory order = the graph scan-order tie-break).
   * DELIVERED IN CHUNKS of 4 packages with event-loop yields between them:
   * the single-shot 6.9 MB delivery blocked the ArkTS main thread past the
   * 6s watchdog (THREAD_BLOCK_6S appfreeze under load). The runtime stages
   * each chunk (web-boot.js `chunked`/`final` flags) and composes on the
   * last; the iOS drive's single-delivery shape is unchanged. */
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
    const packages: string[] = [];
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
      packages.push(JSON.stringify(plugin));
    }
    this.deliverPluginChunks(packages, 0, Date.now() + 60000);
  }

  /** Delivers one 4-package chunk per event-loop turn (the yield keeps the
   * main thread under the watchdog); the last chunk carries `final: true`
   * and composes the boot wire in the runtime. */
  private deliverPluginChunks(packages: string[], at: number,
    deadline: number): void {
    if (!this.started) {
      return;
    }
    if (at >= packages.length) {
      return;
    }
    if (Date.now() > deadline) {
      hilog.error(0x0000, TAG, 'official: web.plugins chunk delivery deadline elapsed');
      return;
    }
    const end = Math.min(at + 4, packages.length);
    const final = end >= packages.length;
    let line = '{"type":"web.plugins","chunked":true,"final":' +
      (final ? 'true' : 'false') + ',"plugins":[';
    const slice = packages.slice(at, end);
    line += slice.join(',') + ']}';
    if (at === 0) {
      hilog.info(0x0000, TAG,
        'official: delivering web.plugins (%{public}d packages in %{public}d chunks)',
        packages.length, Math.ceil(packages.length / 4));
    }
    const status = hostBusDeliver(2, line);
    if (status < 0) {
      hilog.error(0x0000, TAG, 'official: compose failed at chunk %{public}d', at);
      return;
    }
    if (final) {
      hilog.info(0x0000, TAG, 'official: web.plugins delivered (final chunk)');
      return;
    }
    setTimeout((): void => {
      this.deliverPluginChunks(packages, end, deadline);
    }, 1);
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
      const result = msg.result ?? {};
      this.bridge.respondAPI(msg.rpcId ?? '', JSON.stringify(result));
      this.observeRespond(result);
    } else if (msg.type === 'mux.item') {
      this.bridge.muxItem(msg.streamId ?? '', JSON.stringify(msg.value ?? {}));
    } else if (msg.type === 'mux.error') {
      // The runtime answers non-journal streams itself (web-boot.js), so a
      // relayed gateway/unimplemented error crosses this seam — pin the
      // honest surface boundary before the frame reaches the page.
      const details = msg.details;
      const endpoint = details !== undefined && details['endpoint'] !== undefined ?
        String(details['endpoint']) : '';
      if (endpoint.length > 0) {
        this.emitOnce(this.legScenario, 'session.services.pending', {
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

  /** The first REAL session.list answer through the seam (from the
   * already-shaped ok envelope the runtime posted) — session-live leg. */
  private observeRespond(result: Record<string, Object>): void {
    if (this.respondLogged || result['ok'] !== true) {
      return;
    }
    const value = result['value'] as Record<string, Object> | undefined;
    const items = value !== undefined && value['items'] !== undefined ?
      value['items'] as Array<Record<string, Object>> : undefined;
    if (items === undefined) {
      return;
    }
    this.respondLogged = true;
    this.emit(this.legScenario, 'session.list.responded', {
      'ok': true, 'sessions': items.length,
      'source': 'the on-device spine (ctx.sessions)',
    });
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
    this.emitOnce(this.legScenario, 'web.boot.applied', {
      'rows': rows.length,
      'source': this.spineLeg ?
        'runtime (spine + vendored @deepseek-ai/dsh-client-modules)' :
        'runtime (vendored @deepseek-ai/dsh-client-modules)',
    });
    // The composed module graph, observed carrier-side (the canonical
    // scenario logs the same fact as runtime.booted under the b1 id; the
    // harmony manifest pins the harmony scenario id, so the entry list is
    // mirrored here — the session-live leg's runtime logs under the right
    // id, so this mirror stays mount-leg only).
    const entries = (boot.graph ?? {})['entries'] as
      Array<Record<string, string>> | undefined;
    if (entries !== undefined && !this.spineLeg) {
      this.emitOnce(this.legScenario, 'runtime.composed', {
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
      this.emitOnce(this.legScenario, 'index.injected', { 'rows': rows, 'bytes': bytes });
    };
    dist.onIndexServed = (): void => {
      this.emit(this.legScenario, 'index.served', { 'path': '/', 'status': 200 });
    };
    dist.onAssetServed = (path: string): void => {
      this.observeAsset(path);
    };
    plugins.onComboServed = (url: string, bytes: number): void => {
      this.observeCombo(url, bytes);
    };
    bridge.onUpgradeAccepted = (path: string): void => {
      this.emitOnce(this.legScenario, 'upgrade.accepted', { 'path': path });
    };
    this.server.onSeatOpen = (path: string): void => {
      this.emitOnce(this.legScenario, 'mux.upgraded', { 'path': path });
    };
    bridge.onAPICall = (endpoint: string, answered: string): void => {
      this.observeRPC(endpoint, answered);
    };
    bridge.onMuxOpen = (streamId: string, endpoint: string): void => {
      this.observeMuxOpen(streamId, endpoint);
    };
    bridge.onMuxFrame = (direction: string, kind: string): void => {
      // One tx item frame line per leg (once; the probe reports the full
      // frame facts). The write leg's first tx item is the page's follow
      // feeds, not the journal — the source label names the honest shape.
      if (direction !== 'tx' || kind !== 'item' || this.frameLogged) {
        return;
      }
      this.frameLogged = true;
      this.emit(this.legScenario, 'journal.frame.forwarded', {
        'direction': 'tx', 'first': true,
        'source': this.writeLeg ?
          'REAL follow feeds (snapshot/baseline + live turn frames)' :
          'REAL session log records (baseline + live turn)',
      });
    };
    bridge.onMuxErrorFrame = (endpoint: string): void => {
      // The carrier-v0 answer path (unclaimed mux): record the leg BEFORE
      // the error frame hook fires. On the session-live leg a relayed
      // runtime error arrives through onBusLine instead (same event, the
      // honest services boundary — only the claimed surface changed).
      this.emitOnce(this.legScenario, 'session.services.pending', {
        'leg': endpoint,
        'reason': 'the first mux stream open was answered gateway/unimplemented; ' +
          'the web-boot closure embeds no agent spine — the session API is ' +
          'the next named gap',
      });
    };
  }

  /** rpc.observed: the CLAIMED surface logs the first call of each distinct
   * endpoint (session.list forwarded — the probe and the UI both cross it);
   * the unavailable boot burst logs its honest FIRST only — the burst's
   * internal order is ArkWeb fetch scheduling and raced between two runs
   * (dynamicCordisRunner inventory/syncInspectManifest swapped), so only
   * the stable first is a pin. */
  private observeRPC(endpoint: string, answered: string): void {
    if (answered === 'forwarded') {
      if (this.rpcLogged.has(endpoint)) {
        return;
      }
      this.rpcLogged.add(endpoint);
    } else {
      if (this.emittedEvents.has('rpc.observed')) {
        return;
      }
      this.emittedEvents.add('rpc.observed');
    }
    this.emit(this.legScenario, 'rpc.observed', {
      'endpoint': endpoint, 'answered': answered,
    });
  }

  /** The first mux seat open (whoever opens it — the UI's own stream or the
   * probe's), plus the journal-specific attach pin on the session-live leg. */
  private observeMuxOpen(streamId: string, endpoint: string): void {
    this.emitOnce(this.legScenario, 'session.attached', {
      'streamId': streamId, 'stream': endpoint,
    });
    if (endpoint === 'session/journal' && !this.journalAttachLogged) {
      this.journalAttachLogged = true;
      this.emit(this.legScenario, 'journal.attached', {
        'streamId': streamId, 'stream': endpoint,
      });
    }
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
    if (this.writeLeg) {
      this.runWriteProbe(runJs);
      return;
    }
    if (this.spineLeg) {
      this.runSessionProbe(runJs);
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

  /** The b3 probe flow (session-live leg): define `__b3Run`, then poll its
   * parked result (the probe paces the UI burst, posts the REAL RPC,
   * attaches the journal, and collects frames — tens of seconds, so the
   * poll deadline is generous; rule 8). */
  private runSessionProbe(runJs: (script: string) => Promise<string>): void {
    runJs(SessionLiveProbe.probeScript()).then((): Promise<string> => {
      return this.pollSessionProbe(runJs, Date.now() + 150000, '');
    }).then((json: string): void => {
      this.consumeProbeLive(json);
    }).catch((err: Error): void => {
      this.finishSessionLeg(false,
        'session-live probe failed: ' + (err.message ?? 'unknown'));
    });
  }

  /** The b3 poll loop: reads the parked result AND the stage heartbeat (a
   * hung leg names its stage, never a silent starve). The rejection
   * PROPAGATES — the deadline always reaches the caller (the b1 poll once
   * swallowed it at the recursion level and hung; that shape is gone). */
  private pollSessionProbe(runJs: (script: string) => Promise<string>,
    deadline: number, lastStage: string): Promise<string> {
    return runJs('JSON.stringify({out: window.__b3Out ?? null,' +
      ' stage: window.__b3Stage ?? null})').then((json: string):
      Promise<string> => {
      let out: string | null = null;
      let stage = lastStage;
      try {
        const decoded: Object = JSON.parse(json) as Object;
        const wrapper = (typeof decoded === 'string' ?
          JSON.parse(decoded as string) : decoded) as Record<string, Object>;
        out = wrapper['out'] === null || wrapper['out'] === undefined ?
          null : String(wrapper['out']);
        stage = wrapper['stage'] === undefined ? lastStage : String(wrapper['stage']);
      } catch (e) {
        out = null;
      }
      if (stage !== lastStage) {
        hilog.info(0x0000, TAG, 'session-live: probe stage %{public}s', stage);
      }
      if (out !== null && out.length > 0) {
        return Promise.resolve(out);
      }
      if (Date.now() > deadline) {
        return Promise.reject(new Error('probe deadline elapsed (stage: ' +
          stage + ')'));
      }
      return new Promise<string>((resolve: (v: string) => void,
        reject: (e: Error) => void): void => {
        setTimeout((): void => {
          this.pollSessionProbe(runJs, deadline, stage).then(resolve, reject);
        }, 300);
      });
    });
  }

  /** The b3 probe verdict: unfold the passing probe's events into canonical
   * lines and finish the leg; a failed leg finishes loud with the first
   * failed leg's diagnosis. */
  private consumeProbeLive(json: string): void {
    if (this.finished) {
      return;
    }
    hilog.info(0x0000, TAG, 'session-live: probe raw %{public}s', json.substring(0, 120));
    let value = json;
    try {
      const decoded: Object = JSON.parse(json) as Object;
      if (typeof decoded === 'string') {
        value = decoded as string;
      }
    } catch (e) {
      // keep the raw text: parseVerdict names it unparsable
    }
    const verdict = SessionLiveProbe.parseVerdict(value);
    if (verdict.failed) {
      this.finishSessionLeg(false, verdict.reason);
      return;
    }
    verdict.events.forEach((item: LegEvent): void => {
      this.emit(this.legScenario, item.event, item.fields);
    });
    this.finishSessionLeg(true, '');
  }

  /** Terminal marker of a probe-driven leg (session-live / write): the
   * completion evidence line plus the verdict line the E2E drive waits for
   * (the scenario stays resident, so the C phase verdict never fires — the
   * drive owns the verdict, the platform twin of iOS's session-live
   * finish). A passing session-live leg chains into the write leg. */
  private finishSessionLeg(passed: boolean, reason: string): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const complete = this.writeLeg ? 'write.live.complete' : 'session.live.complete';
    const fields: Record<string, Object> = passed ?
      { 'status': 'pass' } : { 'status': 'fail', 'reason': reason };
    this.emit(this.legScenario, complete, fields);
    let line = 'dsh.spike.verdict: ' + this.legScenario + (passed ? ' PASS' : ' FAIL');
    line += ' probe=' + (passed ? 'pass' : 'fail');
    if (!passed) {
      line += ' error="' + reason + '"';
    }
    hostCarrierLine(2, line);
    hilog.info(0x0000, TAG, 'probe leg %{public}s: %{public}s', this.legScenario,
      passed ? 'PASS' : 'FAIL ' + reason);
    if (passed && !this.writeLeg) {
      // The write leg rides a FRESH runtime after the session-live leg
      // (deferred off any NAPI call stack, the b1→httpfetch precedent).
      const phase = this;
      setTimeout((): void => {
        if (phase.ctx !== null) {
          phase.runWriteLeg(phase.ctx);
        }
      }, 200);
    }
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
        // The rejection PROPAGATES through the chain — the caller's catch
        // fails loud (a swallowed rejection here once hung the leg silently).
        return Promise.reject(new Error('probe deadline elapsed'));
      }
      return new Promise<string>((resolve: (v: string) => void,
        reject: (e: Error) => void): void => {
        setTimeout((): void => {
          this.pollProbe(runJs, deadline).then(resolve, reject);
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
   * on-device). Its scenario id keeps the capture filterable. On completion
   * (polled off hostStatus — the C verdict line is the logged evidence) the
   * chain continues into the session-live leg. */
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
    this.awaitHttpFetchThenChain(ctx, Date.now() + 180000);
  }

  /** Bounded condition poll for the httpfetch leg's completion (rule 8) —
   * the scenario completes itself, so the next leg never races it. A red
   * verdict still fails loud through a FAIL verdict line (the drive's wait
   * must never starve). */
  private awaitHttpFetchThenChain(ctx: common.UIAbilityContext,
    deadline: number): void {
    const tick = (): void => {
      if (!this.started) {
        return;
      }
      let complete = false;
      let pass = false;
      try {
        const status = JSON.parse(hostStatus(2)) as Record<string, Object>;
        complete = status['complete'] === 1;
        pass = status['pass'] === 1;
      } catch (e) {
        hilog.error(0x0000, TAG, 'httpfetch: status unparsable');
      }
      if (complete) {
        if (pass) {
          setTimeout((): void => {
            this.runSessionLiveLeg(ctx);
          }, 200);
        } else {
          hostCarrierLine(2, 'dsh.spike.verdict: ' + SCENARIO_SESSION +
            ' FAIL probe=not-run error="the httpfetch leg failed; session-live leg not started"');
        }
        return;
      }
      if (Date.now() > deadline) {
        hostCarrierLine(2, 'dsh.spike.verdict: ' + SCENARIO_SESSION +
          ' FAIL probe=not-run error="the httpfetch leg never completed"');
        return;
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 1000);
  }

  // ---- the session-live leg (W-HARMONY3) -----------------------------------------

  /** After the httpFetch leg: a fresh runtime runs the harmony session-live
   * scenario — the FULL spine boots (ctx.sessions / agents / agentLoop /
   * tools / systemPrompt + the vendored dsh-llm over the REAL httpFetch
   * against the carrier's scripted /mock-llm endpoint), one scripted-llm
   * turn becomes the journal baseline, then the official boot wire mounts
   * on the SAME ctx and the claims go live (session.list + session/journal
   * from ctx.sessions). The origin opens only after web.boot; the b3 probe
   * drives the read path through the official envelope. */
  runSessionLiveLeg(ctx: common.UIAbilityContext): void {
    if (!this.started) {
      return;
    }
    hostFree(2);
    this.started = false;
    // Per-leg evidence state: this leg's capture file holds exactly this
    // leg's manifest records.
    this.emittedEvents = new Set<string>();
    this.rpcLogged = new Set<string>();
    this.legScenario = SCENARIO_SESSION;
    this.spineLeg = true;
    this.journalAttachLogged = false;
    this.respondLogged = false;
    this.frameLogged = false;
    this.bootApplied = false;
    this.originOpened = false;
    this.finished = false;
    this.assetLogged = false;
    this.comboLogged = false;
    this.comboPending = null;
    const capturePath = this.capturePath.replace('official', 'session');
    hostStart(this.webRoot, capturePath, this.fsRoot, OFFICIAL_DESCRIPTOR,
      (line: string): void => {
        this.onBusLine(line);
      },
      (callId: number, name: string, args: string): void => {
        this.onDispatch(ctx, callId, name, args);
      }, SCENARIO_SESSION);
    this.started = true;
    this.emit(this.legScenario, 'client.selected', {
      'client': 'dsh-web-official', 'source': 'launch',
    });
    const status = hostEval(2, ENTRY_SESSION);
    hilog.info(0x0000, TAG, 'session-live leg: eval status %{public}d', status);
    // runtime.config rides the BUS seam (__dshBusOnMessage — the scenario's
    // take('runtime.config')), never the gateway event seam.
    this.deliverBus('{"type":"runtime.config","mockLlmUrl":"http://127.0.0.1:' +
      this.port + '/mock-llm","apiKey":"' + MOCK_LLM_KEY +
      '","containerRoot":' + JSON.stringify(this.webRoot) + '}');
    this.deliverWebPlugins(ctx);
  }

  /** One host → runtime bus delivery (the b3 protocol's runtime.config and
   * the staged web.plugins both arrive this way). */
  private deliverBus(jsonText: string): void {
    if (!this.started) {
      return;
    }
    const status = hostBusDeliver(2, jsonText);
    if (status < 0) {
      hilog.error(0x0000, TAG, 'session-live: bus deliver failed');
    }
  }

  // ---- the write leg (W-HARMONY4) --------------------------------------------------

  /** After the session-live leg: a fresh runtime runs the harmony write-live
   * scenario — the spine boots and the web-boot producer composes WITH the
   * write surface (upstream/web-write.js): session/create + session/prompt
   * (upstream commands.prompt admission) + the session/follow,
   * workspace/follow, session/control and $events streams + the settings
   * describe/update/mutate provider, all answered from ctx. The origin opens
   * only after web.boot; the write probe drives the OFFICIAL composer like a
   * user and the page's own message admits a REAL agent-loop turn. */
  runWriteLeg(ctx: common.UIAbilityContext): void {
    if (!this.started) {
      return;
    }
    hostFree(2);
    this.started = false;
    // Per-leg evidence state: this leg's capture file holds exactly this
    // leg's manifest records.
    this.emittedEvents = new Set<string>();
    this.rpcLogged = new Set<string>();
    this.legScenario = SCENARIO_WRITE;
    this.spineLeg = true;
    this.writeLeg = true;
    this.journalAttachLogged = false;
    this.respondLogged = false;
    this.frameLogged = false;
    this.bootApplied = false;
    this.originOpened = false;
    this.finished = false;
    this.assetLogged = false;
    this.comboLogged = false;
    this.comboPending = null;
    const capturePath = this.capturePath.replace('official', 'write');
    hostStart(this.webRoot, capturePath, this.fsRoot, OFFICIAL_DESCRIPTOR,
      (line: string): void => {
        this.onBusLine(line);
      },
      (callId: number, name: string, args: string): void => {
        this.onDispatch(ctx, callId, name, args);
      }, SCENARIO_WRITE);
    this.started = true;
    this.emit(this.legScenario, 'client.selected', {
      'client': 'dsh-web-official', 'source': 'launch',
    });
    const status = hostEval(2, ENTRY_WRITE);
    hilog.info(0x0000, TAG, 'write leg: eval status %{public}d', status);
    // runtime.config rides the BUS seam (__dshBusOnMessage — the scenario's
    // take('runtime.config')), never the gateway event seam.
    this.deliverBus('{"type":"runtime.config","mockLlmUrl":"http://127.0.0.1:' +
      this.port + '/mock-llm","apiKey":"' + MOCK_LLM_KEY +
      '","containerRoot":' + JSON.stringify(this.webRoot) + '}');
    this.deliverWebPlugins(ctx);
  }

  /** The write probe flow: define the `__b4w` legs, then drive them in
   * order — pick the seeded workspace, type into the composer, send. Each
   * leg's verdict unfolds into canonical lines; a failing leg finishes the
   * leg loud (rule 5). */
  private runWriteProbe(runJs: (script: string) => Promise<string>): void {
    runJs(SessionWriteProbe.probeScript()).then((): void => {
      this.runWriteStep(runJs, 0);
    }).catch((err: Error): void => {
      this.finishSessionLeg(false,
        'write probe setup failed: ' + (err.message ?? 'unknown'));
    });
  }

  /** One write step: launch the leg, poll its parked output, unfold its
   * verdict, advance. The last step's verdict completes the leg. Step 1
   * paces ~2.5s before send so the drive's composer-typed screenshot lands
   * first (real wall-clock pacing for real capture physics, rule 8). */
  private runWriteStep(runJs: (script: string) => Promise<string>, step: number): void {
    const legs: string[] = ['pick', 'type', 'send'];
    if (step >= legs.length) {
      return;
    }
    const advance = (): void => {
      if (step + 1 < legs.length) {
        this.runWriteStep(runJs, step + 1);
      } else {
        this.finishSessionLeg(true, '');
      }
    };
    const launcher = SessionWriteProbe.legLauncher(legs[step], WRITE_MESSAGE);
    runJs(launcher).then((): Promise<string> => {
      return this.pollWriteStep(runJs, legs[step], step,
        Date.now() + (step === 2 ? 90000 : 60000), '');
    }).then((json: string): void => {
      this.consumeWriteStep(legs[step], json);
      if (this.finished) {
        return; // the step's verdict failed the leg
      }
      if (step === 1) {
        // The composer-typed screenshot window (the drive snapshots on the
        // composer.typed line) — pace, then send.
        setTimeout((): void => advance(), 4000);
        return;
      }
      advance();
    }).catch((err: Error): void => {
      this.finishSessionLeg(false,
        `write probe ${legs[step]}: ` + (err.message ?? 'unknown'));
    });
  }

  /** The write-step poll loop: reads the parked result AND the stage
   * heartbeat (a hung leg names its stage). The rejection PROPAGATES — the
   * deadline always reaches the caller (the b3 poll shape). */
  private pollWriteStep(runJs: (script: string) => Promise<string>, leg: string,
    step: number, deadline: number, lastStage: string): Promise<string> {
    return runJs(SessionWriteProbe.readExpr(leg)).then((json: string):
      Promise<string> => {
      let out: string | null = null;
      let stage = lastStage;
      try {
        const decoded: Object = JSON.parse(json) as Object;
        const wrapper = (typeof decoded === 'string' ?
          JSON.parse(decoded as string) : decoded) as Record<string, Object>;
        out = wrapper['out'] === null || wrapper['out'] === undefined ?
          null : String(wrapper['out']);
        stage = wrapper['stage'] === undefined ? lastStage : String(wrapper['stage']);
      } catch (e) {
        out = null;
      }
      if (stage !== lastStage) {
        hilog.info(0x0000, TAG, 'write: probe stage %{public}s', stage);
      }
      if (out !== null && out.length > 0) {
        return Promise.resolve(out);
      }
      if (Date.now() > deadline) {
        return Promise.reject(new Error(`deadline elapsed (stage: ${stage})`));
      }
      return new Promise<string>((resolve: (v: string) => void,
        reject: (e: Error) => void): void => {
        setTimeout((): void => {
          this.pollWriteStep(runJs, leg, step, deadline, stage).then(resolve, reject);
        }, 300);
      });
    });
  }

  /** One write step's verdict: unfold the passing leg's events into
   * canonical lines; a failing leg finishes loud with its diagnosis. */
  private consumeWriteStep(leg: string, json: string): void {
    hilog.info(0x0000, TAG, 'write: %{public}s raw %{public}s', leg,
      json.substring(0, 120));
    let value = json;
    try {
      const decoded: Object = JSON.parse(json) as Object;
      if (typeof decoded === 'string') {
        value = decoded as string;
      }
    } catch (e) {
      // keep the raw text: the unfold names it unparsable
    }
    let verdict: WriteVerdict;
    if (leg === 'pick') {
      verdict = SessionWriteProbe.pickEvents(value);
    } else if (leg === 'type') {
      verdict = SessionWriteProbe.typeEvents(value);
    } else {
      verdict = SessionWriteProbe.sendEvents(value);
    }
    if (verdict.failed) {
      this.finishSessionLeg(false, verdict.reason);
      return;
    }
    verdict.events.forEach((item: WriteLegEvent): void => {
      this.emit(this.legScenario, item.event, item.fields);
    });
  }

  /** The SCRIPTED model boundary: POST /mock-llm/chat/completions — real
   * loopback HTTP + SSE whose script mirrors the vendored dsh-llm-mock-
   * server's success stream byte-for-byte (successText 'Hello from
   * upstream', 5-char deltas, terminal chunk with finish_reason + usage,
   * [DONE]) and its fixed bearer check (401 JSON on a bad key). The drive
   * chooses the success script unconditionally. */
  private registerScriptedLlm(): void {
    this.server.register('exact', MOCK_LLM_PATH,
      (req: CarrierRequest, conn: socket.TCPSocketConnection): void => {
        this.serveScriptedLlm(req, conn);
      });
  }

  private serveScriptedLlm(req: CarrierRequest,
    conn: socket.TCPSocketConnection): void {
    if (req.method !== 'POST') {
      this.server.respondText(conn, 405, 'text/plain', 'method not allowed');
      return;
    }
    if (req.headers['authorization'] !== 'Bearer ' + MOCK_LLM_KEY) {
      // The vendored mock's fixed 401 leg: JSON error body, provider shape.
      const body = '{"error":{"message":"mock authentication failed",' +
        '"type":"mock_error","code":"invalid_api_key"}}';
      this.server.respondText(conn, 401, 'application/json', body);
      return;
    }
    const successText = 'Hello from upstream';
    let sse = '';
    for (let at = 0; at < successText.length; at += 5) {
      const chunk = successText.substring(at, Math.min(at + 5, successText.length));
      sse += 'data: {"choices":[{"index":0,"delta":{"content":"' + chunk +
        '"},"finish_reason":null}]}\n\n';
    }
    sse += 'data: {"choices":[{"index":0,"delta":{"content":""},' +
      '"finish_reason":"stop"}],"usage":{"prompt_tokens":3,' +
      '"completion_tokens":' + successText.length + '}}\n\n';
    sse += 'data: [DONE]\n\n';
    // One Content-Length response: the transport consumes the SSE bytes
    // from the plain body (no chunked framing needed on loopback).
    this.server.respondText(conn, 200, 'text/event-stream; charset=utf-8', sse);
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
