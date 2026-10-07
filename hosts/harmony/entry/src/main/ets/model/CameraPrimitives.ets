// dsh:logging-exempt (hilog here is drive/progress evidence only; canonical
// E2E lines route through the HostPhase phase sink — ONE writer)
/**
 * The capability plane's camera family (proposal v1.10.0) — ArkTS sibling of
 * hosts/ios Gateway/CameraPrimitives.swift + the Kotlin CameraPrimitives:
 * the capture BURST (`cameraCapture`) is the v1 implementation face — each
 * frame lands in the app's capture scope (scope "app" is the C backend's own
 * profile container, <filesDir>/dsh-fs/, so captures write beside it under
 * captures/ and read back through fsRead) and the whole burst is one call,
 * one audit record. The recording rows (`cameraRecordStart`/`Stop`) answer
 * `unavailable` — their shape is contract, their implementation is phased.
 *
 * Two consent layers, gateway first: the manifest's `camera` family grant
 * reaches this handler only after the gateway's own check; the OS
 * permission (ohos.permission.CAMERA, module.json5) is the second layer,
 * and an OS refusal settles null — a value, never an error. A device (or
 * emulator image) with no camera service rejects `unavailable` — the honest
 * gap, the pasteboard posture. Every settle is guarded: the sibling host
 * services' promises can hang forever on an emulator image (measured), and
 * a dead promise must not dead-end the scenario.
 *
 * Threading: every settle happens on an async completion of the ArkTS main
 * thread event loop — the ONE serial JS runtime thread (ARCHITECTURE.md §6);
 * never inside the dispatch call itself.
 */
import { camera } from '@kit.CameraKit';
import { image } from '@kit.ImageKit';
import { abilityAccessCtrl, common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import fs from '@ohos.file.fs';
import { SettleFn } from './PickerPrimitives';
import { ApprovalPresenter } from './DevicePlanePrimitives';

const TAG: string = 'dsh.app';

interface CaptureArgs {
  count?: number;
  format?: string;
  flash?: string;
  maxBytes?: number;
  tag?: string;
}

/** The requestPermissionsFromUser result's consumed shape. */
interface PermRequestResult {
  authResults: Array<number>;
}

/** One CapturedPhoto (the proposal's frozen shape). */
class PhotoEntry {
  scope: string = '';
  path: string = '';
  bytes: number = 0;
  width: number = 0;
  height: number = 0;
  format: string = 'jpeg';
  capturedAt: string = '';
}

/** Settles exactly once across the guard timeout, the rejections and the
 * payload: the burst's LAST resort (a dead camera-service promise must not
 * dead-end the scenario). */
class OnceSettle {
  private done: boolean = false;
  private readonly callId: number;
  private readonly settle: SettleFn;

  constructor(callId: number, settle: SettleFn) {
    this.callId = callId;
    this.settle = settle;
  }

  settleOk(payload: string): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.settle(this.callId, payload, true);
  }

  reject(code: string, message: string): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.settle(this.callId,
      '{"code":"' + code + '","primitive":"cameraCapture","message":"' +
      message + '"}', false);
  }
}

/** Host-declared burst range (the proposal's "host clamps to a declared
 * range"); the audit carries requested and honored counts. */
const MAX_BURST: number = 8;
/** The overall capture guard: a burst that never completes (a dead camera
 * service promise) rejects unavailable instead of hanging the scenario. */
const CAPTURE_GUARD_MS: number = 20000;

function isoNow(): string {
  const d = new Date();
  const pad = (n: number): string => n < 10 ? '0' + n : '' + n;
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
    + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds())
    + 'Z';
}

function flashMode(name: string): camera.FlashMode {
  if (name === 'on') {
    return camera.FlashMode.FLASH_MODE_OPEN;
  }
  if (name === 'off') {
    return camera.FlashMode.FLASH_MODE_CLOSE;
  }
  return camera.FlashMode.FLASH_MODE_AUTO;
}

export class CameraPrimitives {
  private ctx: common.UIAbilityContext;
  private presenter: ApprovalPresenter | null = null;

  constructor(ctx: common.UIAbilityContext) {
    this.ctx = ctx;
  }

  /** The gateway-layer consent surface — the SAME presenter presentApproval
   * uses (HostPhase wires it alongside the device primitives'). */
  setApprovalPresenter(presenter: ApprovalPresenter): void {
    this.presenter = presenter;
  }

  /** The phased recording rows: shape now, implementation phased (proposal
   * §3) — the honest `unavailable`, never a pretend recording. */
  recordPhased(name: string, callId: number, settle: SettleFn): void {
    settle(callId,
      '{"code":"unavailable","primitive":"' + name + '","message":' +
      '"phased — the capture burst is the v1 implementation face"}', false);
  }

  // ---- cameraCapture ---------------------------------------------------------

  capture(callId: number, argsText: string, settle: SettleFn): void {
    let args: CaptureArgs = {};
    try {
      args = JSON.parse(argsText) as CaptureArgs;
    } catch (e) {
      settle(callId,
        '{"code":"invalid","primitive":"cameraCapture","message":"malformed args"}', false);
      return;
    }
    const requested: number = args.count ?? 1;
    const count: number = Math.min(Math.max(requested, 1), MAX_BURST);
    const flashName: string = args.flash ?? 'auto';
    if (['off', 'auto', 'on'].indexOf(flashName) < 0) {
      settle(callId,
        '{"code":"invalid","primitive":"cameraCapture","message":' +
        '"flash must be off | auto | on: ' + flashName + '"}', false);
      return;
    }
    const once = new OnceSettle(callId, settle);
    setTimeout((): void => {
      once.reject('unavailable', 'camera service did not settle (guard timeout)');
    }, CAPTURE_GUARD_MS);
    if (this.presenter === null) {
      once.reject('unavailable', 'no approval presenter');
      return;
    }
    hilog.info(0x0000, TAG, 'ui-wait camera-approval');
    const presenter = this.presenter;
    // The GATEWAY layer answers first (the proposal's two-layer rule): a
    // caller the user declined here never reaches the OS prompt.
    presenter('Allow camera capture?', (approved: boolean): void => {
      if (!approved) {
        hilog.info(0x0000, TAG, 'ui-done camera-approval declined');
        once.settleOk('null'); // gateway-layer refusal is a value (null)
        return;
      }
      hilog.info(0x0000, TAG, 'ui-done camera-approval approved');
      this.requestGrantThenCapture(requested, count, flashName, args.maxBytes, once);
    });
  }

  /** The OS prompt is the second consent layer: granted → the burst; refused
   * → settle null (a value, never an error). */
  private requestGrantThenCapture(requested: number, count: number, flashName: string,
    maxBytes: number | undefined, once: OnceSettle): void {
    let request: Promise<PermRequestResult>;
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      request = atManager.requestPermissionsFromUser(this.ctx, ['ohos.permission.CAMERA']);
    } catch (e) {
      const be = e as BusinessError;
      once.reject('unavailable', be.message ?? 'permission refused');
      return;
    }
    request.then((result: PermRequestResult): void => {
      const granted = result.authResults.length > 0 && result.authResults[0] === 0;
      if (!granted) {
        hilog.info(0x0000, TAG, 'ui-done camera-permission declined');
        once.settleOk('null'); // OS-layer refusal resolves null
        return;
      }
      hilog.info(0x0000, TAG, 'ui-done camera-permission granted');
      this.runBurst(requested, count, flashName, maxBytes, once);
    }).catch((err: BusinessError): void => {
      once.reject('unavailable', err.message ?? 'permission refused');
    });
  }

  /** The burst: one photo session, `count` sequential captures, one settle. */
  private runBurst(requested: number, count: number, flashName: string,
    maxBytes: number | undefined, once: OnceSettle): void {
    let manager: camera.CameraManager;
    let cameras: Array<camera.CameraDevice>;
    let profiles: Array<camera.Profile>;
    try {
      manager = camera.getCameraManager(this.ctx);
      cameras = manager.getSupportedCameras();
      if (cameras.length === 0) {
        once.reject('unavailable', 'no camera on this device');
        return;
      }
      profiles =
        manager.getSupportedOutputCapability(cameras[0], camera.SceneMode.NORMAL_PHOTO).photoProfiles;
      if (profiles.length === 0) {
        once.reject('unavailable', 'no photo profile on this device');
        return;
      }
    } catch (e) {
      const be = e as BusinessError;
      once.reject('unavailable', be.message ?? 'no camera on this device');
      return;
    }
    let session: camera.PhotoSession;
    let input: camera.CameraInput;
    let output: camera.PhotoOutput;
    try {
      session = manager.createSession<camera.PhotoSession>(camera.SceneMode.NORMAL_PHOTO);
      input = manager.createCameraInput(cameras[0]);
      output = manager.createPhotoOutput(profiles[0]);
    } catch (e) {
      const be = e as BusinessError;
      once.reject('unavailable', be.message ?? 'camera session unavailable');
      return;
    }
    const burst = new BurstState(requested, count, flashName, maxBytes,
      profiles[0].size.width, profiles[0].size.height, this.ctx.filesDir,
      session, input, output, once);
    output.on('photoAvailable', (err: BusinessError, photo: camera.Photo): void => {
      if (err) {
        burst.dropFrame();
        return;
      }
      burst.acceptFrame(photo);
    });
    input.open().then((): Promise<void> => {
      session.beginConfig();
      session.addInput(input);
      session.addOutput(output);
      return session.commitConfig();
    }).then((): Promise<void> => {
      const want = flashMode(flashName);
      const use = session.isFlashModeSupported(want) ? want : camera.FlashMode.FLASH_MODE_CLOSE;
      session.setFlashMode(use);
      burst.flashHonored = session.isFlashModeSupported(want) ? flashName : 'off';
      return session.start();
    }).then((): void => {
      burst.shootAll();
    }).catch((err: BusinessError): void => {
      hilog.warn(0x0000, TAG, 'cameraCapture: start refused %{public}s', err.message ?? '?');
      burst.abort();
      once.reject('unavailable', err.message ?? 'camera session refused');
    });
  }
}

/** One burst's accumulator: the frames, the audit facts, the settle. */
class BurstState {
  private readonly requested: number;
  private readonly count: number;
  private readonly flashName: string;
  private readonly maxBytes: number | undefined;
  private readonly width: number;
  private readonly height: number;
  private readonly session: camera.PhotoSession;
  private readonly input: camera.CameraInput;
  private readonly output: camera.PhotoOutput;
  private readonly once: OnceSettle;
  private readonly filesDir: string;
  private readonly startedAt: number = Date.now();
  private readonly photos: Array<PhotoEntry> = [];
  private totalBytes: number = 0;
  private dropped: number = 0;
  private remaining: number;
  private inFlight: number = 0;
  private settled: boolean = false;
  flashHonored: string = 'auto';

  constructor(requested: number, count: number, flashName: string,
    maxBytes: number | undefined, width: number, height: number, filesDir: string,
    session: camera.PhotoSession, input: camera.CameraInput,
    output: camera.PhotoOutput, once: OnceSettle) {
    this.filesDir = filesDir;
    this.requested = requested;
    this.count = count;
    this.flashName = flashName;
    this.maxBytes = maxBytes;
    this.width = width;
    this.height = height;
    this.remaining = count;
    this.session = session;
    this.input = input;
    this.output = output;
    this.once = once;
  }

  shootAll(): void {
    this.inFlight = this.count;
    for (let i = 0; i < this.count; i++) {
      this.output.capture().catch((err: BusinessError): void => {
        hilog.warn(0x0000, TAG, 'cameraCapture: capture failed %{public}s', err.message ?? '?');
        this.dropFrame();
      });
    }
  }

  /** One frame: JPEG component → the capture scope file → a CapturedPhoto.
   * A failed read counts as dropped — the countdown always advances. */
  acceptFrame(photo: camera.Photo): void {
    const img = photo.main;
    img.getComponent(image.ComponentType.JPEG).then((component): void => {
      const data = new Uint8Array(component.byteBuffer.slice(0));
      img.release().catch((_e: BusinessError): void => {});
      photo.release().catch((_e: BusinessError): void => {});
      this.landed(data);
    }).catch((err: BusinessError): void => {
      hilog.warn(0x0000, TAG, 'photo component read failed %{public}s', err.message ?? '?');
      img.release().catch((_e: BusinessError): void => {});
      photo.release().catch((_e: BusinessError): void => {});
      this.dropFrame();
    });
  }

  private landed(data: Uint8Array): void {
    if (this.settled) {
      return;
    }
    if (this.maxBytes === undefined || data.length <= this.maxBytes) {
      const entry = this.land(data);
      if (entry !== null) {
        this.photos.push(entry);
        this.totalBytes += data.length;
      } else {
        this.dropped += 1;
      }
    } else {
      this.dropped += 1; // an over-cap frame is dropped, never truncated
    }
    this.advance();
  }

  /** The capture-failure resume: a dropped frame advances the countdown. */
  dropFrame(): void {
    if (this.settled) {
      return;
    }
    this.dropped += 1;
    this.advance();
  }

  private advance(): void {
    this.inFlight -= 1;
    this.remaining -= 1;
    if (this.remaining > 0 || this.inFlight > 0) {
      return;
    }
    this.settled = true;
    this.finish();
  }

  /** One frame's CapturedPhoto: written into the capture scope (<filesDir>/
   * dsh-fs/captures, the C backend's app-scope root), read back through
   * fsRead("app", "captures/<name>"). */
  private land(data: Uint8Array): PhotoEntry | null {
    try {
      const dir = this.filesDir + '/dsh-fs/captures';
      if (!fs.accessSync(dir)) {
        fs.mkdirSync(dir, true);
      }
      const token = util.generateRandomUUID(true);
      const name = 'capture-' + token.substring(0, 8) + '.jpg';
      const file = fs.openSync(dir + '/' + name, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
      fs.writeSync(file.fd, data.buffer);
      fs.closeSync(file);
      const entry = new PhotoEntry();
      entry.scope = 'app';
      entry.path = 'captures/' + name;
      entry.bytes = data.length;
      entry.width = this.width;
      entry.height = this.height;
      entry.format = 'jpeg';
      entry.capturedAt = isoNow();
      return entry;
    } catch (e) {
      const be = e as BusinessError;
      hilog.warn(0x0000, TAG, 'capture land failed %{public}s', be.message ?? '?');
      return null;
    }
  }

  private finish(): void {
    this.teardown();
    const elapsed = Date.now() - this.startedAt;
    hilog.info(0x0000, TAG,
      'cameraCapture burst done count %{public}d requested %{public}d bytes %{public}d flash %{public}s %{public}dms',
      this.photos.length, this.requested, this.totalBytes, this.flashHonored, elapsed);
    this.once.settleOk('{"photos":' + JSON.stringify(this.photos) + '}');
  }

  /** The failure abort (public: the caller tears its own dead session down
   * before settling the rejection). */
  abort(): void {
    this.teardown();
  }

  private teardown(): void {
    try {
      this.session.stop().catch((_e: BusinessError): void => {});
    } catch (e) {
      // teardown is best-effort — the burst already has its verdict
    }
    try {
      this.input.close().catch((_e: BusinessError): void => {});
    } catch (e) {
      // best-effort
    }
    try {
      this.session.release().catch((_e: BusinessError): void => {});
    } catch (e) {
      // best-effort
    }
    try {
      this.output.release().catch((_e: BusinessError): void => {});
    } catch (e) {
      // best-effort
    }
  }
}
