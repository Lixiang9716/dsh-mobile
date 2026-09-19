/*
 * Index — the M5 host page. On appear it materializes the bundled spike
 * (byte-identical rawfile copies of the runtime/spike originals) into the
 * app cache dir preserving layout, then calls startSpike ONCE, on the UI
 * thread, synchronously inside the NAPI call (single serial JS thread —
 * ARCHITECTURE.md §6). One launch drives both scenarios: m1.spike.boot
 * (regression) and m2.bridge.smoke over the gateway bridge. The returned
 * summary is the human verdict; the E2E verdict is the checker over the
 * captured `dsh.spike.log:` lines (never this Text, never a screenshot).
 */
import { startSpike } from 'libspike.so';
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'dsh.app';

// bundle-root-relative files shipped under resources/rawfile/spike/ —
// logger.js must sit at <bundle>/logger.js, gateway.js at <bundle>/gateway.js,
// the scenarios at <bundle>/scenario/..., the vendored package under
// <bundle>/vendor/... (the spike host's ESM loader resolves these paths).
const BUNDLE_FILES: string[] = [
  'logger.js',
  'gateway.js',
  'registry.js',
  'scenario/m1-spike-boot.js',
  'scenario/m2-bridge-smoke.js',
  'scenario/m2-session.js',
  'system-plugins/dsh-fs/index.js',
  'system-plugins/dsh-subprocess-quickjs/index.js',
  'system-plugins/dsh-ui/index.js',
  'vendor/dsh/util-crypto@0.1.6-alpha.1/lib/index.js'
];

@Entry
@Component
struct Index {
  @State verdict: string = 'spike: running...';

  aboutToAppear(): void {
    this.runSpike();
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
      })
      .catch((err: BusinessError) => {
        this.verdict = 'FAIL (' + (err.message ?? JSON.stringify(err)) + ')';
        hilog.error(0x0000, TAG, 'spike failed: %{public}s', err.message ?? 'unknown');
      });
  }

  build() {
    Column({ space: 16 }) {
      Text('DSH M5 host — HarmonyOS')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
      Text('scenarios m1.spike.boot + m2.bridge.smoke + m2.session · quickjs-ng 0.17.0 via NAPI')
        .fontSize(14)
        .fontColor('#666666')
      Text(this.verdict)
        .fontSize(18)
        .fontColor(this.verdict.startsWith('PASS') ? '#0a7d32' : '#b3261e')
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
