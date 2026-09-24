// dsh:logging-exempt (the serving seat writes no canonical line of its own:
// every `dsh.spike.log:` record is written by the drive that installs the
// hooks below — single-logger discipline; hilog lines here are operator
// progress, not log events)
/**
 * OfficialServe — the SERVING seat for the official DSH Web Client: the
 * ArkTS half of the `ctx.webServer` contract subset (WebDist as the fallback
 * seat, WebPlugins over /plugins, ApiBridge over /api) on CarrierServer,
 * plus the web-boot runtime that composes the OFFICIAL boot wire, the
 * staged /plugins delivery, and the ONE origin open.
 *
 * THE FILE BOUNDARY — this is the release/harness split. Everything in this
 * file runs in BOTH configurations: a plain launch of the user-facing build
 * reaches the official DSH Web UI through exactly this seat, with no launch
 * parameters and nothing staged from outside (the dist + the client bundles
 * ship in rawfile; the rows come from the in-runtime composer). Everything
 * the E2E drives add ON TOP — the per-event canonical records, the
 * same-origin probes, the httpFetch / session-live / write legs, the
 * verdicts — lives in OfficialPhase.ets and reaches this seat ONLY through
 * the hook properties below, whose defaults are no-ops. A user-facing boot
 * installs none of them and never names them, so a release launch emits no
 * record of any kind (AGENTS.md constraint 5, rules.md rule L4).
 *
 * The contract with a drive: `begin` (mount entry) or
 * `startLeg` + `evalLeg` (a fresh runtime on this same carrier), then
 * `deliverBus` / `deliverWebPlugins` / `deliverEvent` as that leg's protocol
 * requires. The seat never decides what a leg means; it serves and reports.
 *
 * Threading: every call runs on the ArkTS main thread — the ONE serial JS
 * runtime thread (ARCHITECTURE.md §6). Bus callbacks from C re-enter ArkTS
 * synchronously and only send (never re-enter the runtime).
 */
import {
  hostBusDeliver,
  hostEval,
  hostEvent,
  hostFree,
  hostSettle,
  hostStart,
} from 'libspike.so';
import { common } from '@kit.AbilityKit';
import { socket } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';
import { fileIo as fs } from '@kit.CoreFileKit';
import { CarrierRequest, CarrierServer, HttpHandler } from './CarrierServer';
import { WebDist, BootRow } from './WebDist';
import { WebPlugins } from './WebPlugins';
import { ApiBridge } from './ApiBridge';
import { HttpFetch } from './HttpFetch';

const TAG: string = 'dsh.app';
/** The official carrier's first port (the legacy m2/m5 phases keep 17877). */
export const OFFICIAL_BASE_PORT: number = 17890;
/** The rawfile prefix the staged web-plugins packages live under (the same
 * tree the build's vendor-official.sh stages, one dir per published package). */
const PLUGIN_PACKAGES_PREFIX: string = 'spike/officialweb/plugins/npm/@deepseek-ai/';
/** The canonical mount-entry scenario the web-boot runtime runs: it composes
 * the official boot wire and posts `web.boot` over the bus seam. */
const ENTRY_MOUNT = 'scenario/officialweb-web-live.js';
/** The INTERACTIVE mount entry (the user-facing seat): the FULL vendored DSH
 * spine boots — llm/session/agent/tools/system-prompt/settings/agent-loop
 * plus the commands registry and the skill plane — claims the write surface,
 * the settings describe and the mux streams, and goes RESIDENT: the page's
 * own composer admits real upstream agent-loop turns. Kotlin/Swift sibling:
 * hosts/android SessionServe.kt, hosts/ios SessionServe.swift. */
const ENTRY_INTERACTIVE = 'scenario/composer-web-live.js';
/** The mount entry's scenario label (the C host logs its verdict under it). */
const SCENARIO_MOUNT = 'harmony.officialweb.mount';
/** The scripted model boundary of the INTERACTIVE seat (the same byte-for-
 * byte success stream the harness's dsh-llm-mock mirror serves): without a
 * staged credential this route answers every turn, so the whole UI works
 * with no model configured. */
const MOCK_LLM_PATH = '/mock-llm/chat/completions';
const MOCK_LLM_KEY = 'mock-key-0001';
/** The recovery defaults row the carrier injects beside the runtime's rows
 * (upstream `__DSH_CONNECTION_RECOVERY__`). */
const RECOVERY_DEFAULTS = '{"backoffBaseMs":500,"backoffFactor":2,' +
  '"backoffMaxMs":10000,"generationReadyWarnMs":3000,' +
  '"generationReadyTimeoutMs":15000}';
/** The official-phase RuntimeDescriptor: httpFetch v2 is REAL on this host
 * (the streaming body bridge, model/HttpFetch.ets) — 6 available / 3
 * unavailable. The frozen m5 phase keeps its 5/4 v1 descriptor. */
export const OFFICIAL_DESCRIPTOR = '{"available":["fsRead","fsWrite","fsScope",' +
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

export class OfficialServe {
  // ---- the evidence seam ------------------------------------------------------
  // All no-ops: a user-facing boot installs none of them (no record, no
  // probe, no verdict). The harness drive assigns the ones it needs before
  // `begin`. Each hook reports a SERVING fact — the meaning of it is the
  // drive's business.

  /** Listening on a loopback port; the runtime for the mount entry exists. */
  onCarrierUp: (port: number) => void = (port: number): void => {};
  onIndexRendered: (rows: number, bytes: number) => void =
    (rows: number, bytes: number): void => {};
  onIndexServed: () => void = (): void => {};
  onAssetServed: (path: string) => void = (path: string): void => {};
  onComboServed: (url: string, bytes: number) => void =
    (url: string, bytes: number): void => {};
  onUpgradeAccepted: (path: string) => void = (path: string): void => {};
  onSeatOpen: (path: string) => void = (path: string): void => {};
  onAPICall: (endpoint: string, answered: string) => void =
    (endpoint: string, answered: string): void => {};
  onMuxOpen: (streamId: string, endpoint: string) => void =
    (streamId: string, endpoint: string): void => {};
  onMuxFrame: (direction: string, kind: string) => void =
    (direction: string, kind: string): void => {};
  /** One mux ERROR frame's stream endpoint — the honest services boundary
   * (both the carrier-v0 answer path and a relayed runtime error name it). */
  onMuxErrorFrame: (endpoint: string) => void = (endpoint: string): void => {};
  /** The runtime's `web.boot` landed: rows swapped into the render pipeline
   * and the /plugins revs overridden (entries = the composed graph's ids). */
  onWebBoot: (rows: number, entries: string[]) => void =
    (rows: number, entries: string[]): void => {};
  /** One claimed /api response crossed back to the page. */
  onAPIRespond: (result: Record<string, Object>) => void =
    (result: Record<string, Object>): void => {};

  /** The serving output: the loopback origin (token included) to mount. */
  onOrigin: (url: string) => void = (url: string): void => {};

  // ---- serving state ----------------------------------------------------------

  private server: CarrierServer = new CarrierServer();
  private dist: WebDist | null = null;
  private plugins: WebPlugins | null = null;
  private bridge: ApiBridge | null = null;
  private http: HttpFetch = new HttpFetch();
  private token: string = '';
  private port: number = 0;
  private started = false;
  private bootApplied = false;
  private originOpened = false;
  /** Set by `finish()`: the drive has closed this leg's evidence, so a late
   * composition must not remount a page a verdict already covered. Only a
   * MOUNTING leg clears it again (`startLeg(…, mounts = true)`). */
  private finished = false;
  private webRoot: string = '';
  private fsRoot: string = '';
  private capturePath: string = '';
  /** The INTERACTIVE seat (the user-facing boot): the mount entry is the
   * resident spine scenario, the runtime.config carries the workspace / the
   * interactive rows (commands + skills) / the staged credential, and the
   * carrier serves the scripted model route as the no-credential fallback. */
  private interactive: boolean = false;
  private credentialJson: string | null = null;

  /** The staged credential file (`<filesDir>/profiles/default/llm/
   * config.json` — the same shape and location the `llm.live-stream` runner
   * stages at): baseUrl/apiKey/model (+ optional provider). Absent or
     malformed yields null — the seat then serves the scripted route. Nothing
     here logs the key: a credential that never reaches a record cannot leak
     into one. */
  static loadCredential(ctx: common.UIAbilityContext): string | null {
    const path: string = ctx.filesDir + '/profiles/default/llm/config.json';
    let text: string = '';
    try {
      text = fs.readTextSync(path);
    } catch (e) {
      return null;
    }
    try {
      const obj: Record<string, Object> = JSON.parse(text) as Record<string, Object>;
      const baseUrl = obj['baseUrl'] as string ?? '';
      const apiKey = obj['apiKey'] as string ?? '';
      const model = obj['model'] as string ?? '';
      if (baseUrl.length === 0 || apiKey.length === 0 || model.length === 0) {
        return null;
      }
      return text;
    } catch (e) {
      return null;
    }
  }

  /** The user-facing boot (the INTERACTIVE seat): the full spine through
   * composer-web-live.js — the commands registry + the skill plane mount,
   * the write surface / settings describe / mux streams are claimed, and a
   * staged credential (or the scripted route) backs every turn. */
  beginInteractive(ctx: common.UIAbilityContext, webRoot: string,
    capturePath: string, fsRoot: string, credentialJson: string | null): void {
    this.interactive = true;
    this.credentialJson = credentialJson;
    const workspace: string = fsRoot + '/workspace';
    try {
      fs.mkdirSync(workspace + '/home/agents', true);
      fs.mkdirSync(workspace + '/skills', true);
    } catch (e) {
      hilog.error(0x0000, TAG, 'interactive: workspace mkdir failed');
    }
    this.begin(ctx, webRoot, capturePath, fsRoot);
  }

  /** Boots the mount leg: routes → listen → runtime → web.boot → origin. The
   * served output is the official app; who consumes it is the caller's. */
  begin(ctx: common.UIAbilityContext, webRoot: string, capturePath: string,
    fsRoot: string): void {
    this.webRoot = webRoot;
    this.capturePath = capturePath;
    this.fsRoot = fsRoot;
    this.token = OfficialServe.randomToken();
    this.startCarrier(ctx);
  }

  /** The carrier seat, for a drive that registers its own verification
   * routes on the SAME transport (the harness's scripted model boundary).
   * The serving path itself never needs it. */
  seat(): CarrierServer {
    return this.server;
  }

  /** Whether a runtime is live on this seat (the drives' precondition). */
  isStarted(): boolean {
    return this.started;
  }

  /** The loopback port the carrier took (0 before it is listening). */
  loopbackPort(): number {
    return this.port;
  }

  /** The staged web-plugins package directory listing. The rawfile APIs are
   * documented to throw, and a throw here means the build never staged the
   * official plugins into rawfile — so the failure is re-stated with the
   * searched prefix (that text names the defect; a bare BusinessError does
   * not) and the drive that requested the delivery reports it. */
  private pluginPackageDirs(ctx: common.UIAbilityContext): string[] {
    try {
      return ctx.resourceManager.getRawFileListSync(PLUGIN_PACKAGES_PREFIX);
    } catch (e) {
      const be = e as BusinessError;
      throw new Error('official-web plugins not staged: ' + PLUGIN_PACKAGES_PREFIX +
        ' (code=' + (be.code ?? -1) + ' ' + (be.message ?? 'unknown') + ')');
    }
  }

  private startCarrier(ctx: common.UIAbilityContext): void {
    const dirs = this.pluginPackageDirs(ctx);
    this.dist = new WebDist(this.server,
      (rel: string): Uint8Array | null => this.rawFile(ctx, rel), this.token);
    this.plugins = new WebPlugins(this.server,
      (rel: string): Uint8Array | null => this.rawFile(ctx, rel), dirs);
    this.bridge = new ApiBridge(this.server, this.token);
    this.server.registerFallback(this.dist.handler);
    this.server.register('prefix', '/plugins', this.plugins.handler);
    this.bridge.install();
    if (this.interactive) {
      // The scripted model boundary of the interactive seat (the no-
      // credential fallback): the same bytes the harness's mock serves.
      this.server.register('exact', MOCK_LLM_PATH,
        (req: CarrierRequest, conn: socket.TCPSocketConnection): void => {
          this.serveScriptedLlm(req, conn);
        });
    }
    this.wireSeats();
    // Carrier → runtime seam: claimed /api requests and mux.open/cancel
    // deliveries ride the bus (the runtime's answers come back as
    // api.respond / mux.item|error|end posts).
    this.bridge.deliverToRuntime = (jsonText: string): void => {
      const status = hostBusDeliver(2, jsonText);
      if (status < 0) {
        hilog.error(0x0000, TAG, 'official: bus deliver failed');
      }
    };
    this.server.start(OFFICIAL_BASE_PORT).then((port: number): void => {
      this.port = port;
      // hostStart FIRST: the drive's canonical lines route through the phase
      // sink (hostCarrierLine), which is only live once the runtime exists.
      const entry = this.interactive ? ENTRY_INTERACTIVE : SCENARIO_MOUNT;
      this.startRuntime(ctx, entry);
      this.onCarrierUp(port);
      this.evalEntry(entry);
      if (this.interactive) {
        // The spine's take('runtime.config') consumes this (workspace, the
        // interactive rows, the model route) before any surface mounts.
        this.deliverBus(this.interactiveConfig());
      }
      this.deliverWebPlugins(ctx);
    }).catch((err: Error): void => {
      hilog.error(0x0000, TAG, 'official: carrier failed: %{public}s',
        err.message ?? 'unknown');
    });
  }

  /** Routes the seats' observation points at the hooks (no-op by default). */
  private wireSeats(): void {
    const dist = this.dist;
    const plugins = this.plugins;
    const bridge = this.bridge;
    if (dist === null || plugins === null || bridge === null) {
      return;
    }
    dist.onIndexRendered = (rows: number, bytes: number): void => {
      this.onIndexRendered(rows, bytes);
    };
    dist.onIndexServed = (): void => {
      this.onIndexServed();
    };
    dist.onAssetServed = (path: string): void => {
      this.onAssetServed(path);
    };
    plugins.onComboServed = (url: string, bytes: number): void => {
      this.onComboServed(url, bytes);
    };
    bridge.onUpgradeAccepted = (path: string): void => {
      this.onUpgradeAccepted(path);
    };
    this.server.onSeatOpen = (path: string): void => {
      this.onSeatOpen(path);
    };
    this.server.onWsFrame = (text: string, path: string): void => {
      bridge.ingestFrame(text, path);
    };
    bridge.onAPICall = (endpoint: string, answered: string): void => {
      this.onAPICall(endpoint, answered);
    };
    bridge.onMuxOpen = (streamId: string, endpoint: string): void => {
      this.onMuxOpen(streamId, endpoint);
    };
    bridge.onMuxFrame = (direction: string, kind: string): void => {
      this.onMuxFrame(direction, kind);
    };
    bridge.onMuxErrorFrame = (endpoint: string): void => {
      this.onMuxErrorFrame(endpoint);
    };
  }

  /** Creates the seat runtime (the drive's sink is live from here on) and
   * wires the httpFetch v2 seam; the entry's eval + the web.plugins delivery
   * follow on the same stack so the boot wire composes while the carrier
   * holds. */
  private startRuntime(ctx: common.UIAbilityContext, scenario: string): void {
    hostStart(this.webRoot, this.capturePath, this.fsRoot, OFFICIAL_DESCRIPTOR,
      (line: string): void => {
        this.onBusLine(line);
      },
      (callId: number, name: string, args: string): void => {
        this.onDispatch(callId, name, args);
      }, scenario);
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

  /** Evals one leg's entry on the live runtime (the runtime composes the
   * official boot wire and posts `web.boot`). The caller owns what the leg
   * delivers around it (runtime.config, the staged web-plugins). */
  evalEntry(entryRel: string): void {
    const status = hostEval(2, entryRel);
    if (status !== 0) {
      hilog.error(0x0000, TAG, 'official: eval %{public}s status %{public}d',
        entryRel, status);
    }
  }

  /** Frees the live runtime and starts a FRESH one on this same carrier —
   * one leg per runtime (per-leg verdict state in the C host). `mounts`
   * says whether the leg re-mounts the official app: a mounting leg clears
   * the origin/finished state so its own `web.boot` opens the origin. The
   * caller then evals that leg's entry and delivers its protocol messages. */
  startLeg(ctx: common.UIAbilityContext, scenario: string, capturePath: string,
    mounts: boolean): void {
    if (!this.started) {
      return;
    }
    hostFree(2);
    this.started = false;
    this.capturePath = capturePath;
    if (mounts) {
      this.bootApplied = false;
      this.originOpened = false;
      this.finished = false;
    }
    this.startRuntime(ctx, scenario);
  }

  /** The drive's terminal marker for the live leg: its evidence is closed, so
   * no later composition may remount a page that evidence already covered. */
  finish(): void {
    this.finished = true;
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
  deliverWebPlugins(ctx: common.UIAbilityContext): void {
    const base64 = new util.Base64Helper();
    const dirs = this.pluginPackageDirs(ctx).slice().sort();
    const packages: string[] = [];
    for (let i = 0; i < dirs.length; i++) {
      const dirName = dirs[i];
      const at = dirName.lastIndexOf('@');
      if (at <= 0) {
        continue;
      }
      const name = '@deepseek-ai/' + dirName.substring(0, at);
      const vfsRoot = '/web-plugins/npm/@deepseek-ai/' + dirName;
      const pkg = this.fileEntry(ctx, base64,
        'officialweb/plugins/npm/@deepseek-ai/' + dirName + '/package.json');
      const bundle = this.fileEntry(ctx, base64,
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

  private fileEntry(ctx: common.UIAbilityContext, base64: util.Base64Helper,
    rel: string): Record<string, Object> | null {
    const bytes = this.rawFile(ctx, rel);
    if (bytes === null) {
      return null;
    }
    const entry: Record<string, Object> = {
      'b64': base64.encodeToStringSync(bytes),
      'mtimeMs': 0,
    };
    return entry;
  }

  private rawFile(ctx: common.UIAbilityContext, rel: string): Uint8Array | null {
    try {
      return ctx.resourceManager.getRawFileContentSync('spike/' + rel);
    } catch (e) {
      return null;
    }
  }

  /** One host → runtime bus delivery (a leg's runtime.config, and the
   * staged web.plugins chunks). */
  deliverBus(jsonText: string): void {
    if (!this.started) {
      return;
    }
    const status = hostBusDeliver(2, jsonText);
    if (status < 0) {
      hilog.error(0x0000, TAG, 'official: bus deliver failed');
    }
  }

  /** One host → runtime gateway event (the httpfetch leg's host.info). */
  deliverEvent(eventJson: string): void {
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
      return; // before the seats exist: nothing to route to
    }
    if (msg.type === 'api.claim') {
      const claim = JSON.parse(line) as ClaimMessage;
      this.bridge.claim(claim.endpoints ?? []);
    } else if (msg.type === 'mux.claim') {
      this.bridge.claimMux();
    } else if (msg.type === 'api.respond') {
      const result = msg.result ?? {};
      this.bridge.respondAPI(msg.rpcId ?? '', JSON.stringify(result));
      this.onAPIRespond(result);
    } else if (msg.type === 'mux.item') {
      this.bridge.muxItem(msg.streamId ?? '', JSON.stringify(msg.value ?? {}));
    } else if (msg.type === 'mux.error') {
      // The runtime answers non-journal streams itself (web-boot.js), so a
      // relayed gateway/unimplemented error crosses this seam — name the
      // honest surface boundary before the frame reaches the page.
      const details = msg.details;
      const endpoint = details !== undefined && details['endpoint'] !== undefined ?
        String(details['endpoint']) : '';
      if (endpoint.length > 0) {
        this.onMuxErrorFrame(endpoint);
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
    // The settings dialog's phone adaptation rides every render (the §1.5
    // `style` row WebDist.settingsPhoneAdaptation carries; see its doc for
    // why the page needs it).
    rows.push(WebDist.settingsPhoneAdaptation);
    if (this.dist !== null) {
      this.dist.indexRows = (): BootRow[] => rows;
    }
    if (this.plugins !== null) {
      this.plugins.applyRuntimeRevs(boot.plugins ?? []);
    }
    const entries = (boot.graph ?? {})['entries'] as
      Array<Record<string, string>> | undefined;
    this.bootApplied = true;
    this.onWebBoot(rows.length, entries === undefined ? [] :
      entries.map((entry: Record<string, string>): string => entry['id'] ?? ''));
    this.maybeOpenOrigin();
  }

  private maybeOpenOrigin(): void {
    if (!this.bootApplied || this.port === 0 || this.originOpened || this.finished) {
      return;
    }
    this.originOpened = true;
    const url = 'http://127.0.0.1:' + this.port + '/?token=' + this.token;
    hilog.info(0x0000, TAG, 'official: opening origin %{public}s', url);
    this.onOrigin(url);
  }

  // ---- gateway dispatch (httpFetch v2) ---------------------------------------------

  /** The INTERACTIVE seat's runtime.config: the workspace (a real directory
   * inside the granted scope — what the agent writes survives relaunches),
   * the scope root, the interactive rows (commands registry + skill plane,
   * all INSIDE the workspace — the fs views refuse anything outside it), and
   * the model route (the staged credential, else the scripted loopback
   * endpoint). The key rides apiKey only; it never reaches a record. */
  private interactiveConfig(): string {
    const workspace: string = this.fsRoot + '/workspace';
    let line = '{"type":"runtime.config","mockLlmUrl":"http://127.0.0.1:' +
      this.port + '/mock-llm","apiKey":"' + MOCK_LLM_KEY +
      '","containerRoot":' + JSON.stringify(workspace) +
      ',"fsScopeRoot":' + JSON.stringify(this.fsRoot) +
      ',"commands":true,"fullCoverage":true,"goals":true,' +
      '"fileReferences":true,"skills":{"dshHome":' +
      JSON.stringify(workspace + '/home') + ',"agentsHome":' +
      JSON.stringify(workspace + '/home/agents') + ',"customSkillDirs":[' +
      JSON.stringify(workspace + '/skills') + ']}';
    if (this.credentialJson !== null) {
      const cred = JSON.parse(this.credentialJson) as Record<string, Object>;
      line += ',"llmBaseUrl":' + JSON.stringify(cred['baseUrl'] ?? '') +
        ',"llmApiKey":' + JSON.stringify(cred['apiKey'] ?? '') +
        ',"llmModel":' + JSON.stringify(cred['model'] ?? '') +
        ',"llmProvider":' + JSON.stringify(cred['provider'] ?? 'openai-compatible');
    }
    line += '}';
    return line;
  }

  /** The SCRIPTED model boundary of the interactive seat: POST
   * /mock-llm/chat/completions — the same byte-for-byte success stream the
   * harness's dsh-llm-mock mirror serves ('Hello from upstream', 5-char
   * deltas, terminal chunk with finish_reason + usage, [DONE]) and its fixed
   * bearer check (401 JSON on a bad key). */
  private serveScriptedLlm(req: CarrierRequest,
    conn: socket.TCPSocketConnection): void {
    if (req.method !== 'POST') {
      this.server.respondText(conn, 405, 'text/plain', 'method not allowed');
      return;
    }
    if (req.headers['authorization'] !== 'Bearer ' + MOCK_LLM_KEY) {
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
    this.server.respondText(conn, 200,
      'text/event-stream; charset=utf-8', sse);
  }

  private onDispatch(callId: number, name: string, args: string): void {
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

  static randomToken(): string {
    let out = '';
    for (let i = 0; i < 32; i++) {
      out += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
    }
    return out;
  }
}
