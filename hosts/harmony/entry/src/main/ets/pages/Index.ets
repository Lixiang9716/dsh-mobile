/*
 * Index — the D9 host page. THREE phases on ONE launch:
 *
 * 1. Regression (synchronous): materializes the bundled spike (byte-identical
 *    rawfile copies of the runtime/spike originals + the Web Client plugin)
 *    into the app cache dir preserving layout, then calls startSpike ONCE on
 *    the UI thread — m1.spike.boot, m2.bridge.smoke, m2.session on the ONE
 *    serial JS thread (ARCHITECTURE.md §6). The returned summary is the human
 *    verdict; the E2E verdict is the checker over the captured
 *    `dsh.spike.log:` lines (never this Text, never a screenshot).
 *
 * 2. Binding phase (event-driven): the loopback carrier serves the materialized
 *    Web Client, ArkWeb mounts it, and HostPhase drives scenario
 *    m5.host-binding over the real dispatch bridge — approval dialog below,
 *    notification lifecycle, live token deltas rendered by the page.
 *
 * 3. Official-web phase (D9 W-HARMONY, event-driven): the m5 verdict chains
 *    into OfficialPhase — the canonical b1-web-live runtime composes the
 *    OFFICIAL boot wire, the carrier serves the vendored upstream dist from
 *    rawfile with the runtime's rows, and ArkWeb mounts the official app
 *    (b-harmony.official-web-mount), then the httpFetch v2 proof leg runs
 *    against the live carrier (b-harmony.httpfetch-v2).
 */
import { startSpike } from 'libspike.so';
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { webview } from '@kit.ArkWeb';
import { CarrierServer } from '../model/CarrierServer';
import { installLegacyRoutes } from '../model/CarrierRoutes';
import { HostPhase } from '../model/HostPhase';
import { OfficialPhase } from '../model/OfficialPhase';

const TAG: string = 'dsh.app';
const CARRIER_BASE_PORT: number = 17877;

// bundle-root-relative files shipped under resources/rawfile/spike/ —
// logger.js must sit at <bundle>/logger.js, gateway.js at <bundle>/gateway.js,
// the scenarios at <bundle>/scenario/..., the vendored package under
// <bundle>/vendor/... (the spike host's ESM loader resolves these paths).
// webclient/... is the ACTIVE Web Client plugin the m5 carrier serves;
// upstream/... + the vendor/npm libs are the D9 web-boot closure the
// official-web phase runs (byte-identical to the runtime/spike canonicals —
// ci/vendor-official.sh cmp-verifies every copy). EXTEND whenever the
// closure grows.
const BUNDLE_FILES: string[] = [
  'logger.js',
  'gateway.js',
  'registry.js',
  'install-pipeline.js',
  'sha256.js',
  'tar-mini.js',
  'fixtures/dsh-notes.js',
  'fixtures/dsh-notes-source.js',
  'scenario/m1-spike-boot.js',
  'scenario/m2-bridge-smoke.js',
  'scenario/m2-session.js',
  'scenario/m5-host-binding.js',
  'scenario/b1-web-live.js',
  'scenario/harmony-httpfetch-v2.js',
  'upstream/web-boot.js',
  'upstream/web-shims.js',
  'upstream/shims/buffer.js',
  'upstream/shims/url.js',
  'upstream/shims/fs.js',
  'upstream/shims/crypto.js',
  'upstream/shims/node-module.js',
  'upstream/shims/path.js',
  'system-plugins/dsh-fs/index.js',
  'system-plugins/dsh-subprocess-quickjs/index.js',
  'system-plugins/dsh-ui/index.js',
  'vendor/dsh/util-crypto@0.1.6-alpha.2/lib/index.js',
  'vendor/npm/cordis@4.0.2/lib/index.js',
  'vendor/npm/cosmokit@1.8.3/lib/index.js',
  'vendor/npm/schemastery@3.18.2/lib/index.mjs',
  'vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/lib/index.js',
  'vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/lib/client.js',
  'webclient/dsh-web-client/manifest.json',
  'webclient/dsh-web-client/web/index.html',
  'webclient/dsh-web-client/web/main.js'
];

// Custom approval dialog — presentApproval's native surface (contract §4:
// approval while pending may checkpoint; the E2E driver taps Approve).
@CustomDialog
struct ApprovalDialog {
  controller: CustomDialogController;
  title: string = 'Approval';
  onPick: (approved: boolean) => void = (approved: boolean): void => {};

  build() {
    Column({ space: 12 }) {
      Text(this.title).fontSize(18).fontWeight(FontWeight.Bold)
      Text('The scenario requests your approval.').fontSize(14)
      Row({ space: 12 }) {
        Button('Decline').onClick((): void => {
          this.onPick(false);
          this.controller.close();
        })
        Button('Approve').onClick((): void => {
          this.onPick(true);
          this.controller.close();
        })
      }
    }
    .padding(20)
  }
}

@Entry
@Component
struct Index {
  @State verdict: string = 'spike: running...';
  @State webUrl: string = '';
  @State approvalTitle: string = '';
  private approvalResolve: ((approved: boolean) => void) | null = null;
  private approvalController: CustomDialogController | null = null;
  private carrier: CarrierServer = new CarrierServer();
  private webController: webview.WebviewController = new webview.WebviewController();

  aboutToAppear(): void {
    this.runSpike();
  }

  aboutToDisappear(): void {
    HostPhase.getInstance().destroy();
    OfficialPhase.getInstance().destroy();
    this.carrier.stop();
  }

  private copyRawFile(ctx: common.Context, rel: string, dst: string): Promise<void> {
    return ctx.resourceManager.getRawFileContent('spike/' + rel).then((data: Uint8Array) => {
      try {
        const dir: string = dst.substring(0, dst.lastIndexOf('/'));
        if (!fs.accessSync(dir)) {
          fs.mkdirSync(dir, true);
        }
        const file = fs.openSync(dst, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
        fs.writeSync(file.fd, data.buffer as object as ArrayBuffer);
        fs.closeSync(file.fd);
      } catch (e) {
        throw new Error(`copyRawFile ${rel}: ${(e as BusinessError).message ?? 'unknown'}`);
      }
    });
  }

  private materializeBundle(ctx: common.Context): Promise<string> {
    const root: string = ctx.cacheDir + '/spike';
    const jobs: Promise<void>[] =
      BUNDLE_FILES.map((rel: string): Promise<void> => this.copyRawFile(ctx, rel, root + '/' + rel));
    return Promise.all(jobs).then((): string => root);
  }

  private runSpike(): void {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const capturePath: string = ctx.cacheDir + '/dsh-spike-capture.log';
    const fsRoot: string = ctx.filesDir + '/spike-fs';
    this.materializeBundle(ctx)
      .then((root: string): string => startSpike(root, capturePath, fsRoot))
      .then((summary: string) => {
        this.verdict = summary;
        hilog.info(0x0000, TAG, 'spike verdict: %{public}s', summary);
        this.startBindingPhase(ctx, fsRoot);
      })
      .catch((err: BusinessError) => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'spike failed: %{public}s', err.message ?? 'unknown');
      });
  }

  /** Phase 2: carrier up → page mounts → scenario runs (see HostPhase). The
   * m5 verdict chains into the D9 official-web phase on a later tick — the
   * completion callback fires from inside a mutator call, so the teardown
   * (hostFree) must never run on that stack (ARCHITECTURE.md §6). */
  private startBindingPhase(ctx: common.UIAbilityContext, fsRoot: string): void {
    const phase = HostPhase.getInstance();
    phase.setApprovalPresenter((title: string, resolve: (approved: boolean) => void): void => {
      this.showApproval(title, resolve);
    });
    phase.pageSink = (text: string): void => {
      this.carrier.sendText(text);
    };
    this.carrier.onStaticServed = (path: string): void => {
      phase.onStaticServed(path);
    };
    this.carrier.onWsText = (text: string): void => {
      phase.onPageText(text);
    };
    const capturePath: string = ctx.cacheDir + '/dsh-host-capture.log';
    this.materializeBundle(ctx)
      .then((root: string): Promise<number> => {
        phase.onPhaseComplete = (passed: boolean): void => {
          hilog.info(0x0000, TAG, 'm5 phase complete (passed %{public}s)',
            String(passed));
          setTimeout((): void => {
            this.startOfficialPhase(ctx, fsRoot);
          }, 200);
        };
        phase.begin(ctx, root, capturePath, fsRoot);
        installLegacyRoutes(this.carrier, root + '/webclient/dsh-web-client/web');
        return this.carrier.start(CARRIER_BASE_PORT).then((port: number): number => {
          phase.onCarrierListening(port);
          this.webUrl = 'http://127.0.0.1:' + port + '/';
          return port;
        });
      })
      .catch((err: BusinessError): void => {
        hilog.error(0x0000, TAG, 'binding phase bootstrap failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  /** Phase 3: the D9 official-web mount (see OfficialPhase). */
  private startOfficialPhase(ctx: common.UIAbilityContext, fsRoot: string): void {
    HostPhase.getInstance().destroy();
    this.carrier.stop();
    const official = OfficialPhase.getInstance();
    official.openOrigin = (url: string): void => {
      // The official origin becomes a FRESH Web's initial src: a src state
      // change on the live m5 Web does not re-navigate, and an explicit
      // loadUrl (from the compose call stack or after the remount) either
      // is swallowed or double-loads. Unmount (webUrl '') and remount with
      // the official origin on a later tick — exactly one navigation.
      this.webUrl = '';
      setTimeout((): void => {
        this.webUrl = url;
      }, 50);
    };
    this.materializeBundle(ctx)
      .then((root: string): void => {
        official.begin(ctx, root, ctx.cacheDir + '/dsh-official-capture.log', fsRoot);
      })
      .catch((err: BusinessError): void => {
        hilog.error(0x0000, TAG, 'official phase bootstrap failed: %{public}s',
          err.message ?? 'unknown');
      });
  }

  private showApproval(title: string, resolve: (approved: boolean) => void): void {
    this.approvalResolve = resolve;
    this.approvalTitle = title;
    this.approvalController = new CustomDialogController({
      builder: ApprovalDialog({
        title: this.approvalTitle,
        onPick: (approved: boolean): void => {
          const resolve = this.approvalResolve;
          this.approvalResolve = null;
          if (resolve !== null) {
            resolve(approved);
          }
        }
      }),
      autoCancel: false,
      customStyle: true
    });
    this.approvalController.open();
  }

  build() {
    Column({ space: 8 }) {
      Text('DSH host — HarmonyOS')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
      Text(this.verdict)
        .fontSize(14)
        .fontColor(this.verdict.startsWith('PASS') ? '#0a7d32' : '#b3261e')
        .maxLines(3)
      if (this.webUrl !== '') {
        Web({ src: this.webUrl, controller: this.webController })
          .width('100%')
          .layoutWeight(1)
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .onControllerAttached(() => {
            hilog.info(0x0000, TAG, 'arkweb: controller attached for %{public}s', this.webUrl);
          })
          .onPageEnd((event) => {
            hilog.info(0x0000, TAG, 'arkweb: page end %{public}s',
              event?.url ?? this.webUrl);
            OfficialPhase.getInstance().onPageFinished(event?.url ?? '',
              (script: string): Promise<string> =>
                this.webController.runJavaScript(script));
          })
      } else {
        Text('carrier: starting...').fontSize(12).fontColor('#666666')
      }
    }
    .width('100%')
    .height('100%')
    .padding(12)
  }
}
