// dsh:logging-exempt (hilog markers drive the E2E UI automation; canonical
// lines route through the phase sink via hostCarrierLine — ONE writer)
/**
 * OfficialPhase — the D9 EVIDENCE drive (b-harmony.official-web-mount), the
 * harmony twin of hosts/ios OfficialWebRuntime.swift + the b1 half of
 * WebBootRuntimeDrive.swift. It owns everything that exists to VERIFY the
 * host and nothing that exists to SERVE it: the official serving stack
 * itself (carrier seats, the web-boot composition, the origin open) is
 * model/OfficialServe.ets, which a user-facing release launch runs with no
 * drive attached at all.
 *
 * This drive attaches to that seat through its hook properties and adds:
 * the per-event canonical `dsh.spike.log:` records (carrier-side
 * observation, single-emission in manifest order), the same-origin probes
 * through the WebView, the SCRIPTED model boundary, the httpFetch /
 * session-live / write proof legs, and the terminal verdicts. Rule 5 holds
 * both ways: a leg that cannot pass fails loud with its diagnosis, and a
 * release build — which has no drives — refuses one by name (Index.ets).
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
import { hostCarrierLine, hostStatus } from 'libspike.so';
import { common } from '@kit.AbilityKit';
import { socket } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CarrierRequest } from './CarrierServer';
import { OfficialServe } from './OfficialServe';
import { SessionLiveProbe, LegEvent } from './SessionLiveProbe';
import { SessionWriteProbe, WriteVerdict, WriteLegEvent, WRITE_MESSAGE } from './SessionWriteProbe';
import { BuildFlavor } from './BuildFlavor';

const TAG: string = 'dsh.app';
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

  /** The serving seat this drive verifies (see OfficialServe — the split). */
  private serve: OfficialServe = new OfficialServe();
  private capturePath: string = '';
  private webRoot: string = '';
  private port: number = 0;
  private ctx: common.UIAbilityContext | null = null;
  private finished = false;
  private bootApplied = false;
  private assetLogged = false;
  private comboLogged = false;
  private comboPending: string | null = null;
  private comboPendingBytes: number = 0;
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

  /** Index wires the ArkWeb controller through these. */
  onPageEnd: () => void = (): void => {};
  openOrigin: (url: string) => void = (url: string): void => {};

  static getInstance(): OfficialPhase {
    if (OfficialPhase.instance === null) {
      OfficialPhase.instance = new OfficialPhase();
    }
    return OfficialPhase.instance;
  }

  /** Boots the whole phase: evidence hooks → the serving seat (routes →
   * listen → runtime → web.boot → origin) → the scripted model boundary. */
  begin(ctx: common.UIAbilityContext, webRoot: string, capturePath: string,
    fsRoot: string): void {
    this.ctx = ctx;
    this.webRoot = webRoot;
    this.capturePath = capturePath;
    this.wireEvidence();
    this.serve.onOrigin = (url: string): void => {
      this.openOrigin(url);
    };
    this.serve.begin(ctx, webRoot, capturePath, fsRoot);
    // After `begin` the seats exist and the listen callback has not run yet
    // (its promise resolves on a later tick), so the drive's verification
    // route lands before any connection can.
    this.registerScriptedLlm();
  }

  /** The evidence seam: every serving fact the drive pins as a canonical
   * record arrives through these hooks (the seat itself never logs). */
  private wireEvidence(): void {
    this.serve.onCarrierUp = (port: number): void => {
      this.port = port;
      this.carrierLine(SCENARIO_OFFICIAL, 'carrier.listening', {
        'transport': 'tcp', 'loopback': true, 'port': port,
      });
      this.carrierLine(SCENARIO_OFFICIAL, 'client.selected', {
        'client': 'dsh-web-official', 'source': 'launch',
      });
    };
    this.serve.onIndexRendered = (rows: number, bytes: number): void => {
      this.emitOnce(this.legScenario, 'index.injected', { 'rows': rows, 'bytes': bytes });
    };
    this.serve.onIndexServed = (): void => {
      this.emit(this.legScenario, 'index.served', { 'path': '/', 'status': 200 });
    };
    this.serve.onAssetServed = (path: string): void => {
      this.observeAsset(path);
    };
    this.serve.onComboServed = (url: string, bytes: number): void => {
      this.observeCombo(url, bytes);
    };
    this.serve.onUpgradeAccepted = (path: string): void => {
      this.emitOnce(this.legScenario, 'upgrade.accepted', { 'path': path });
    };
    this.serve.onSeatOpen = (path: string): void => {
      this.emitOnce(this.legScenario, 'mux.upgraded', { 'path': path });
    };
    this.serve.onAPICall = (endpoint: string, answered: string): void => {
      this.observeRPC(endpoint, answered);
    };
    this.serve.onMuxOpen = (streamId: string, endpoint: string): void => {
      this.observeMuxOpen(streamId, endpoint);
    };
    this.serve.onMuxFrame = (direction: string, kind: string): void => {
      this.observeFrame(direction, kind);
    };
    this.serve.onMuxErrorFrame = (endpoint: string): void => {
      // The honest services boundary, whichever path named it: the
      // carrier-v0 answer for an unclaimed mux open, or a runtime error
      // relayed through the bus seam on a spine leg.
      this.emitOnce(this.legScenario, 'session.services.pending', {
        'leg': endpoint,
        'reason': 'the first mux stream open was answered gateway/unimplemented; ' +
          'the web-boot closure embeds no agent spine — the session API is ' +
          'the next named gap',
      });
    };
    this.serve.onWebBoot = (rows: number, entries: string[]): void => {
      this.observeWebBoot(rows, entries);
    };
    this.serve.onAPIRespond = (result: Record<string, Object>): void => {
      this.observeRespond(result);
    };
  }

  /** The runtime composed the boot wire: pin the applied rows and the
   * composed graph, then let the seat open the origin. */
  private observeWebBoot(rows: number, entries: string[]): void {
    this.bootApplied = true;
    this.emitOnce(this.legScenario, 'web.boot.applied', {
      'rows': rows,
      'source': this.spineLeg ?
        'runtime (spine + vendored @deepseek-ai/dsh-client-modules)' :
        'runtime (vendored @deepseek-ai/dsh-client-modules)',
    });
    // The composed module graph, observed carrier-side (the canonical
    // scenario logs the same fact as runtime.booted under the b1 id; the
    // harmony manifest pins the harmony scenario id, so the entry list is
    // mirrored here — the session-live leg's runtime logs under the right
    // id, so this mirror stays mount-leg only).
    if (entries.length > 0 && !this.spineLeg) {
      this.emitOnce(this.legScenario, 'runtime.composed', {
        'entries': entries,
        'source': 'vendored @deepseek-ai/dsh-client-modules composed in-runtime',
      });
    }
  }

  /** One tx item frame line per leg (once; the probe reports the full frame
   * facts). The write leg's first tx item is the page's follow feeds, not
   * the journal — the source label names the honest shape. */
  private observeFrame(direction: string, kind: string): void {
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
    this.serve.finish();
    const complete = this.writeLeg ? 'write.live.complete' : 'session.live.complete';
    const fields: Record<string, Object> = passed ?
      { 'status': 'pass' } : { 'status': 'fail', 'reason': reason };
    this.emit(this.legScenario, complete, fields);
    if (BuildFlavor.isRelease()) {
      return;
    }
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
    this.serve.finish();
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

  // ---- the httpFetch proof leg -------------------------------------------------------

  /** After the mount completes: a fresh runtime runs the harmony httpFetch
   * v2 scenario against the LIVE carrier (the platform gap flip, proven
   * on-device). Its scenario id keeps the capture filterable. On completion
   * (polled off hostStatus — the C verdict line is the logged evidence) the
   * chain continues into the session-live leg. */
  runHttpFetchLeg(ctx: common.UIAbilityContext): void {
    if (!this.serve.isStarted()) {
      return;
    }
    const capturePath = this.capturePath.replace('official', 'httpfetch');
    // Not a mounting leg: the mount leg's origin state stays latched (a late
    // composition must not remount the page this leg's evidence covered).
    this.serve.startLeg(ctx, SCENARIO_HTTPFETCH, capturePath, false);
    this.serve.evalEntry(ENTRY_HTTPFETCH);
    this.serve.deliverEvent('{"event":"host.info","port":' +
      this.serve.loopbackPort() + '}');
    this.awaitHttpFetchThenChain(ctx, Date.now() + 180000);
  }

  /** Bounded condition poll for the httpfetch leg's completion (rule 8) —
   * the scenario completes itself, so the next leg never races it. A red
   * verdict still fails loud through a FAIL verdict line (the drive's wait
   * must never starve). */
  private awaitHttpFetchThenChain(ctx: common.UIAbilityContext,
    deadline: number): void {
    const tick = (): void => {
      if (!this.serve.isStarted()) {
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
    if (!this.serve.isStarted()) {
      return;
    }
    // Per-leg evidence state: this leg's capture file holds exactly this
    // leg's manifest records.
    this.resetLegEvidence(SCENARIO_SESSION);
    this.serve.startLeg(ctx, SCENARIO_SESSION,
      this.capturePath.replace('official', 'session'), true);
    this.emit(this.legScenario, 'client.selected', {
      'client': 'dsh-web-official', 'source': 'launch',
    });
    this.serve.evalEntry(ENTRY_SESSION);
    this.openLegWithRuntimeConfig(ctx);
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
    if (!this.serve.isStarted()) {
      return;
    }
    // Per-leg evidence state: this leg's capture file holds exactly this
    // leg's manifest records.
    this.resetLegEvidence(SCENARIO_WRITE);
    this.writeLeg = true;
    this.serve.startLeg(ctx, SCENARIO_WRITE,
      this.capturePath.replace('official', 'write'), true);
    this.emit(this.legScenario, 'client.selected', {
      'client': 'dsh-web-official', 'source': 'launch',
    });
    this.serve.evalEntry(ENTRY_WRITE);
    this.openLegWithRuntimeConfig(ctx);
  }

  /** Per-leg evidence reset: the leg's scenario label plus every
   * single-emission guard (each capture file holds exactly its own
   * manifest's records). */
  private resetLegEvidence(scenario: string): void {
    this.emittedEvents = new Set<string>();
    this.rpcLogged = new Set<string>();
    this.legScenario = scenario;
    this.spineLeg = true;
    this.journalAttachLogged = false;
    this.respondLogged = false;
    this.frameLogged = false;
    this.bootApplied = false;
    this.finished = false;
    this.assetLogged = false;
    this.comboLogged = false;
    this.comboPending = null;
  }

  /** The shared tail of a spine leg: the runtime config (which rides the BUS
   * seam — `__dshBusOnMessage`, the scenario's take('runtime.config') —,
   * never the gateway event seam) and the staged web-plugins. */
  private openLegWithRuntimeConfig(ctx: common.UIAbilityContext): void {
    this.serve.deliverBus('{"type":"runtime.config","mockLlmUrl":"http://127.0.0.1:' +
      this.serve.loopbackPort() + '/mock-llm","apiKey":"' + MOCK_LLM_KEY +
      '","containerRoot":' + JSON.stringify(this.webRoot) + '}');
    this.serve.deliverWebPlugins(ctx);
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
   * chooses the success script unconditionally. Registered on the serving
   * seat's own transport: the model boundary is harness machinery riding the
   * carrier, so a user-facing boot never installs it. */
  private registerScriptedLlm(): void {
    this.serve.seat().register('exact', MOCK_LLM_PATH,
      (req: CarrierRequest, conn: socket.TCPSocketConnection): void => {
        this.serveScriptedLlm(req, conn);
      });
  }

  private serveScriptedLlm(req: CarrierRequest,
    conn: socket.TCPSocketConnection): void {
    if (req.method !== 'POST') {
      this.serve.seat().respondText(conn, 405, 'text/plain', 'method not allowed');
      return;
    }
    if (req.headers['authorization'] !== 'Bearer ' + MOCK_LLM_KEY) {
      // The vendored mock's fixed 401 leg: JSON error body, provider shape.
      const body = '{"error":{"message":"mock authentication failed",' +
        '"type":"mock_error","code":"invalid_api_key"}}';
      this.serve.seat().respondText(conn, 401, 'application/json', body);
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
    this.serve.seat().respondText(conn, 200,
      'text/event-stream; charset=utf-8', sse);
  }

  // ---- plumbing ------------------------------------------------------------------

  destroy(): void {
    this.serve.destroy();
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
    // Release strip: the canonical E2E stream is harness-only.
    if (BuildFlavor.isRelease()) {
      return;
    }
    hostCarrierLine(2, 'dsh.spike.log: ' + JSON.stringify(envelope));
  }
}
