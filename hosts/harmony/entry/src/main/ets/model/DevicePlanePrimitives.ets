// dsh:logging-exempt (hilog here is drive/progress evidence only; canonical
// E2E lines route through the HostPhase phase sink — ONE writer)
/**
 * The v1.5.0 device-plane primitives — ArkTS sibling of hosts/ios
 * Gateway/DevicePlanePrimitives.swift + ClipboardPrimitives.swift:
 * deviceInfo (read-only facts), haptic (one cue per call, @ohos.vibrator),
 * keepAwake (the boolean screen latch, window.setWindowKeepScreenOn),
 * presentShare (the system share surface — the sheet IS the per-call
 * consent; the host learns only completion, never the destination), and the
 * clipboard pair (permission `clipboard`; clipboardRead is approval-gated
 * by default through the SAME presenter presentApproval uses, and its
 * audit... rides the settled value only — the text never reaches any log).
 *
 * SDK mapping notes (verified against this SDK's d.ts): haptic maps the
 * closed vocabulary onto one time-type vibration cue per call (distinct
 * durations; this host has no per-pattern waveform compositor); share uses
 * the legacy 'ohos.want.action.sendData' want (no systemShare kit in this
 * image); battery omits lowPowerMode (optional field, no direct read here).
 *
 * Threading: every settle happens on an async completion (promise callback)
 * of the ArkTS main thread event loop — the ONE serial JS runtime thread
 * (ARCHITECTURE.md §6); never inside the dispatch call itself.
 */
import { vibrator } from '@kit.SensorServiceKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { batteryInfo, deviceInfo, systemDateTime } from '@kit.BasicServicesKit';
import { abilityAccessCtrl, bundleManager, common, Want } from '@kit.AbilityKit';
import { display, window } from '@kit.ArkUI';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SettleFn } from './PickerPrimitives';

const TAG: string = 'dsh.app';

/** The requestPermissionsFromUser result's consumed shape (the platform
 * type lives in a non-importable internal module). */
interface PermRequestResult {
  authResults: Array<number>;
}

interface ShareArgs {
  kind?: string;
  text?: string;
  url?: string;
  paths?: Array<string>;
}

interface HoldArgs {
  hold?: boolean;
}

interface PatternArgs {
  pattern?: string;
}

/** Resolves a scope-relative file to a shareable URI (PickerPrimitives). */
export type ScopeResolver = (scope: string, rel: string) => string | null;

/** The approval surface handle — the SAME presenter presentApproval uses. */
export type ApprovalPresenter = (title: string, onResult: (approved: boolean) => void) => void;

/** Settles exactly once: the promise's own outcome, or the guard timeout —
 * the cue was DISPATCHED, but this host's service promise may never settle
 * (the emulator's vibrator and pasteboard can hang), and a dead promise
 * must not dead-end the scenario. The timeout path reports the dispatch as
 * done; a real rejection still settles unavailable first. */
export function settleGuarded(callId: number, p: Promise<void>, settle: SettleFn,
  primitive: string, okPayload: string, timeoutPayload: string, guardMs: number): void {
  let done = false;
  const once = (payload: string, ok: boolean): void => {
    if (done) {
      return;
    }
    done = true;
    settle(callId, payload, ok);
  };
  p.then((): void => once(okPayload, true)).catch((err: BusinessError): void => {
    reject(callId, settle, 'unavailable', primitive, err.message ?? 'refused');
    done = true;
  });
  setTimeout((): void => once(timeoutPayload, true), guardMs);
}

function reject(callId: number, settle: SettleFn, code: string, primitive: string,
  message: string): void {
  settle(callId,
    '{"code":"' + code + '","primitive":"' + primitive + '","message":"' +
    message + '"}', false);
}

/** The window holder: EntryAbility parks the main window here at
 * onWindowStageCreate so keepAwake can latch it without threading the
 * windowStage through every leg. */
export class WindowRef {
  static win: window.Window | null = null;
}

export class DevicePlanePrimitives {
  private ctx: common.UIAbilityContext;
  private resolver: ScopeResolver;
  private presenter: ApprovalPresenter | null = null;

  constructor(ctx: common.UIAbilityContext, resolver: ScopeResolver) {
    this.ctx = ctx;
    this.resolver = resolver;
  }

  setApprovalPresenter(presenter: ApprovalPresenter): void {
    this.presenter = presenter;
  }

  register(): void {
    // The dispatch lives in HostPhase.onDispatch (the C forward list gates
    // what reaches ArkTS); this module only hosts the handlers.
  }

  // ---- deviceInfo -----------------------------------------------------------

  deviceInfo(callId: number, argsText: string, settle: SettleFn): void {
    let versionName: string = '';
    try {
      const info: bundleManager.BundleInfo =
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      versionName = info.versionName ?? '';
    } catch (e) {
      versionName = '';
    }
    // @SuppressWarnings syscap
    let displaySync: display.Display;
    let config: string;
    let timezone: string;
    try {
      // @SuppressWarnings syscap
      displaySync = display.getDefaultDisplaySync();
      config = this.configuration();
      // @SuppressWarnings syscap
      timezone = systemDateTime.getTimezoneSync();
    } catch (e) {
      const be = e as BusinessError;
      reject(callId, settle, 'unavailable', 'deviceInfo', be.message ?? 'device facts refused');
      return;
    }
    const soc: number = batteryInfo.batterySOC;
    let payload: Record<string, Object> = {
      'platform': 'harmonyos',
      'model': deviceInfo.productModel,
      'osVersion': deviceInfo.osFullName,
      'appVersion': versionName,
      'screen': {
        'width': displaySync.width,
        'height': displaySync.height,
        'scale': Math.round(displaySync.densityPixels * 100) / 100,
      } as Record<string, Object>,
      'locale': config.replace('_', '-'),
      'timezone': timezone,
    };
    if (soc >= 0) {
      payload['battery'] = {
        'level': soc / 100,
        'state': this.batteryState(batteryInfo.chargingStatus),
      } as Record<string, Object>;
    }
    settle(callId, JSON.stringify(payload), true);
  }

  /** The system locale, normalized to BCP-47 ("zh_CN" → "zh-CN").
   * @throws { BusinessError } configuration read can refuse */
  private configuration(): string {
    const config = this.ctx.resourceManager.getConfigurationSync();
    return config.locale.length > 0 ? config.locale : 'en-US';
  }

  private batteryState(state: batteryInfo.BatteryChargeState): string {
    switch (state) {
      case batteryInfo.BatteryChargeState.ENABLE:
        return 'charging';
      case batteryInfo.BatteryChargeState.FULL:
        return 'full';
      case batteryInfo.BatteryChargeState.NONE:
      case batteryInfo.BatteryChargeState.DISABLE:
        return 'unplugged';
      default:
        return 'unknown';
    }
  }

  // ---- haptic ---------------------------------------------------------------

  /** One tactile cue per call: the closed vocabulary maps onto distinct
   * time-type durations (this host has no waveform compositor — the
   * mapping is the honest HarmonyOS expression of the vocabulary). */
  haptic(callId: number, argsText: string, settle: SettleFn): void {
    let args: PatternArgs = {};
    try {
      args = JSON.parse(argsText) as PatternArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'haptic', 'malformed args');
      return;
    }
    const durations: Record<string, number> = {
      'light': 20, 'medium': 35, 'heavy': 50, 'rigid': 30, 'soft': 40,
      'selection': 15, 'success': 80, 'warning': 140, 'error': 180,
    };
    const pattern: string = args.pattern ?? '';
    const duration = durations[pattern];
    if (duration === undefined) {
      reject(callId, settle, 'unavailable', 'haptic',
        'pattern not expressible on this platform: ' + pattern);
      return;
    }
    let cue: Promise<void>;
    try {
      cue = vibrator.startVibration(
        { type: 'time', duration: duration } as vibrator.VibrateTime,
        { usage: 'unknown' } as vibrator.VibrateAttribute,
      );
    } catch (e) {
      const be = e as BusinessError;
      reject(callId, settle, 'unavailable', 'haptic', be.message ?? 'vibrator refused');
      return;
    }
    settleGuarded(callId, cue, settle, 'haptic', 'null', 'null', 1500);
  }

  // ---- keepAwake ------------------------------------------------------------

  keepAwake(callId: number, argsText: string, settle: SettleFn): void {
    let args: HoldArgs = {};
    try {
      args = JSON.parse(argsText) as HoldArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'keepAwake', 'malformed args');
      return;
    }
    const hold: boolean = args.hold === true;
    const win = WindowRef.win;
    if (win === null) {
      reject(callId, settle, 'unavailable', 'keepAwake', 'no window is parked');
      return;
    }
    let latch: Promise<void>;
    try {
      latch = win.setWindowKeepScreenOn(hold);
    } catch (e) {
      const be = e as BusinessError;
      reject(callId, settle, 'unavailable', 'keepAwake', be.message ?? 'window refused');
      return;
    }
    settleGuarded(callId, latch, settle, 'keepAwake', 'null', 'null', 2000);
  }

  // ---- presentShare ---------------------------------------------------------

  /** The system share surface: text/url/parameterized files want. The
   * resolution of startAbility means the sheet accepted the payload; a
   * BusinessError (user walked away, or this image has no share target)
   * settles {shared:false} — a value, never an error. Files resolve through
   * the SAME scope discipline as fsRead (outside a granted scope → denied). */
  share(callId: number, argsText: string, settle: SettleFn): void {
    let args: ShareArgs = {};
    try {
      args = JSON.parse(argsText) as ShareArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'presentShare', 'malformed args');
      return;
    }
    hilog.info(0x0000, TAG, 'ui-wait share %{public}s', args.kind ?? '');
    const kind: string = args.kind ?? '';
    if (kind === 'text' || kind === 'url') {
      this.shareText(callId, settle, kind === 'url' ? (args.url ?? '') : (args.text ?? ''), kind);
      return;
    }
    if (kind === 'files') {
      this.shareFiles(callId, settle, args.paths ?? []);
      return;
    }
    reject(callId, settle, 'invalid', 'presentShare',
      'share payload kind must be text | url | files');
  }

  private shareText(callId: number, settle: SettleFn, text: string, kind: string): void {
    if (text.length === 0) {
      reject(callId, settle, 'invalid', 'presentShare', kind + ' payload expects a string');
      return;
    }
    const want: Want = {
      'action': 'ohos.want.action.sendData',
      'type': 'text/plain',
      'parameters': { 'key_text': text } as Record<string, Object>,
    };
    this.startShare(callId, settle, want);
  }

  /** Files: each path is "<scopeHandle>:<scope-relative path>"; the resolver
   * (the picker's scope registry) settles denied for anything ungranted. */
  private shareFiles(callId: number, settle: SettleFn, paths: Array<string>): void {
    if (paths.length === 0) {
      reject(callId, settle, 'invalid', 'presentShare',
        'files payload expects a non-empty paths array');
      return;
    }
    const uris: Array<string> = [];
    for (let i = 0; i < paths.length; i++) {
      const at = paths[i].indexOf(':');
      if (at <= 0) {
        reject(callId, settle, 'invalid', 'presentShare',
          'path must be "<scope>:<relative path>": ' + paths[i]);
        return;
      }
      const scope = paths[i].substring(0, at);
      const rel = paths[i].substring(at + 1);
      const uri = this.resolver(scope, rel);
      if (uri === null) {
        reject(callId, settle, 'denied', 'presentShare',
          'path outside a granted scope: ' + paths[i]);
        return;
      }
      uris.push(uri);
    }
    const want: Want = {
      'action': 'ohos.want.action.sendData',
      'type': '*/*',
      'uri': uris[0],
      'parameters': { 'ability.params.stream': uris } as Record<string, Object>,
    };
    this.startShare(callId, settle, want);
  }

  private startShare(callId: number, settle: SettleFn, want: Want): void {
    // Every share outcome is a VALUE ({shared:false}) — the contract says
    // the sheet is its own consent and the user walking away (or this
    // image having no share target at all, measured 2026-09-26) is never
    // an error. The guard timeout is the no-completion value.
    let done = false;
    const once = (payload: string): void => {
      if (done) {
        return;
      }
      done = true;
      hilog.info(0x0000, TAG, 'ui-done share settled');
      settle(callId, payload, true);
    };
    try {
      hilog.warn(0x0000, TAG, 'startAbility: calling');
      const handoff = this.ctx.startAbility(want);
      handoff.then((): void => {
        hilog.info(0x0000, TAG, 'ui-done share accepted');
        once('{"shared":true}');
      }).catch((err: BusinessError): void => {
        hilog.info(0x0000, TAG, 'ui-done share not completed: %{public}d', err.code ?? -1);
        once('{"shared":false}');
      });
    } catch (e) {
      const be = e as BusinessError;
      hilog.info(0x0000, TAG, 'ui-done share not started: %{public}d', be.code ?? -1);
      once('{"shared":false}');
      return;
    }
    setTimeout((): void => once('{"shared":false}'), 8000);
  }

  // ---- clipboard (approval-gated read) ---------------------------------------

  clipboardRead(callId: number, argsText: string, settle: SettleFn): void {
    let title = 'Allow clipboard read?';
    try {
      const args = JSON.parse(argsText) as Record<string, string | undefined>;
      if (args.title !== undefined && args.title.length > 0) {
        title = args.title;
      }
    } catch (e) {
      // default title stands
    }
    if (this.presenter === null) {
      reject(callId, settle, 'unavailable', 'clipboardRead', 'no presenter');
      return;
    }
    hilog.info(0x0000, TAG, 'ui-wait clipboard-read');
    const presenter = this.presenter;
    presenter(title, (approved: boolean): void => {
      if (!approved) {
        hilog.info(0x0000, TAG, 'ui-done clipboard-read declined');
        settle(callId, 'null', true); // refusal is a value, not an error
        return;
      }
      hilog.info(0x0000, TAG, 'ui-done clipboard-read approved');
      this.settlePasteboard(callId, settle);
    });
  }

  /** The pasteboard read + settle, after consent. The direct read is tried
   * FIRST (the app's own pasteboard writes read back without the system
   * grant — and the emulator image never shows the READ_PASTEBOARD dialog,
   * its request promise hangs: measured 2026-09-26); only a permission
   * rejection falls back to requesting the platform grant (the real-device
   * path). Empty/non-text is null. */
  private settlePasteboard(callId: number, settle: SettleFn): void {
    let text = '';
    try {
      // @SuppressWarnings syscap
      // @SuppressWarnings permission
      const data: pasteboard.PasteData = pasteboard.getSystemPasteboard().getDataSync();
      text = data.getRecordCount() > 0 ? data.getPrimaryText() : '';
    } catch (e) {
      const be = e as BusinessError;
      hilog.warn(0x0000, TAG, 'pasteboard direct read refused: %{public}s', be.message ?? '?');
      this.requestGrantThenRead(callId, settle);
      return;
    }
    if (text.length > 0) {
      settle(callId, '{"kind":"text","text":' + JSON.stringify(text) + '}', true);
    } else {
      settle(callId, 'null', true);
    }
  }

  /** The real-device fallback: request READ_PASTEBOARD, then read. */
  private requestGrantThenRead(callId: number, settle: SettleFn): void {
    let request: Promise<PermRequestResult>;
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      request = atManager.requestPermissionsFromUser(this.ctx,
        ['ohos.permission.READ_PASTEBOARD']);
    } catch (e) {
      const be = e as BusinessError;
      reject(callId, settle, 'unavailable', 'clipboardRead', be.message ?? 'permission refused');
      return;
    }
    request.then((result: PermRequestResult): void => {
      const granted = result.authResults.length > 0
        && result.authResults[0] === 0;
      if (!granted) {
        reject(callId, settle, 'unavailable', 'clipboardRead',
          'READ_PASTEBOARD refused by user policy');
        return;
      }
      try {
        // @SuppressWarnings syscap
        // @SuppressWarnings permission
        const data: pasteboard.PasteData = pasteboard.getSystemPasteboard().getDataSync();
        const text = data.getRecordCount() > 0 ? data.getPrimaryText() : '';
        if (text.length > 0) {
          settle(callId, '{"kind":"text","text":' + JSON.stringify(text) + '}', true);
        } else {
          settle(callId, 'null', true);
        }
      } catch (e) {
        const be = e as BusinessError;
        reject(callId, settle, 'unavailable', 'clipboardRead', be.message ?? 'pasteboard refused');
      }
    }).catch((err: BusinessError): void => {
      reject(callId, settle, 'unavailable', 'clipboardRead', err.message ?? 'permission refused');
    });
  }

  clipboardWrite(callId: number, argsText: string, settle: SettleFn): void {
    let args: Record<string, string | undefined> = {};
    try {
      args = JSON.parse(argsText) as Record<string, string | undefined>;
    } catch (e) {
      reject(callId, settle, 'invalid', 'clipboardWrite', 'malformed args');
      return;
    }
    const text = args.text;
    if (text === undefined || typeof text !== 'string') {
      reject(callId, settle, 'invalid', 'clipboardWrite', 'text missing');
      return;
    }
    try {
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
      const put = pasteboard.getSystemPasteboard().setData(data);
      // The write settles when the pasteboard actually READS BACK the text
      // (this image's setData promise can hang — measured 2026-09-26 — and
      // a timeout-only settle would let the caller read the PREVIOUS
      // clipboard). Poll the synchronous read; the promise's own settle is
      // the last-resort guard.
      let tries = 0;
      const poll = (): void => {
        let landed = false;
        try {
          // @SuppressWarnings syscap
          // @SuppressWarnings permission
          const check: pasteboard.PasteData = pasteboard.getSystemPasteboard().getDataSync();
          const seen = check.getRecordCount() > 0 ? check.getPrimaryText() : '';
          hilog.warn(0x0000, TAG, 'clipboardWrite poll: seen %{public}d chars, match %{public}s',
            seen.length, String(seen === text));
          landed = seen === text;
        } catch (e) {
          landed = false;
        }
        if (landed || tries >= 16) {
          if (!landed) {
            // The pasteboard service took the write but nothing reads back —
            // on this image the service is non-functional (measured
            // 2026-09-26). An honest capability gap, never a pretend-ok.
            hilog.warn(0x0000, TAG, 'clipboardWrite: read-back never landed');
            reject(callId, settle, 'unavailable', 'clipboardWrite',
              'pasteboard write did not land (service non-functional)');
            return;
          }
          settle(callId, 'null', true);
          return;
        }
        tries += 1;
        setTimeout(poll, 250);
      };
      put.then((): void => {
        poll();
      }).catch((err: BusinessError): void => {
        reject(callId, settle, 'unavailable', 'clipboardWrite', err.message ?? 'pasteboard refused');
      });
      setTimeout(poll, 250);
    } catch (e) {
      const be = e as BusinessError;
      reject(callId, settle, 'unavailable', 'clipboardWrite', be.message ?? 'pasteboard refused');
    }
  }

  /** The picker seed helper shares util.generateRandomUUID via this module's
   * sibling; nothing else needed here. */
  static newToken(): string {
    return util.generateRandomUUID(true);
  }
}
