// dsh:logging-exempt (hilog here IS the marker channel: `dsh.app` markers
// drive the E2E UI automation; canonical lines route through the phase sink
// via hostCarrierLine so the capture keeps ONE writer)
/**
 * HostPhase — the M5 binding phase controller (mission pieces 2+3). Owns
 * the event-driven NAPI runtime (libspike.so host* functions), the loopback
 * carrier's message shuttle, and the ArkTS capability layer:
 *
 *   - notify          → @ohos.notification (requestEnableNotification +
 *                       publish with a wantAgent; the notification tap
 *                       routes back as onNotifyResponse → notify.response)
 *   - presentApproval → custom ArkUI dialog, presented via the presenter
 *                       callback Index registers (ui-wait/ui-done markers)
 *   - presentPicker,
 *     keychainGet/Set,
 *     httpFetch       → honestly `unavailable` (binding descriptor; the v2
 *                       paths — user-scope fs + persist, HUKS, streaming
 *                       body bridge — are documented in the agent note)
 *   - fsScope         → app-scope v1 (persist = resolve to the app files
 *                       scope), served by the C backend
 *   - app.state       → EntryAbility lifecycle edges → hostEvent
 *
 * Threading: every NAPI call runs on the ArkTS main thread — the ONE serial
 * JS runtime thread (ARCHITECTURE.md §6). The onBus/onDispatch callbacks
 * fire from C while JS runs; they only queue/send (never re-enter the
 * runtime synchronously) — settlements ride later UI-callback ticks.
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
import { wantAgent } from '@kit.AbilityKit';
import { notificationManager } from '@kit.NotificationKit';
import notification from '@ohos.notification';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'dsh.app';
const PHASE_ID: number = 1;
const SCENARIO: string = 'm5.host-binding';

/** Binding RuntimeDescriptor: 5 available / 4 unavailable (honest v1 — see
 * the class comment; keep in sync with the agent note's decision record). */
export const BINDING_DESCRIPTOR: string = '{"available":["fsRead","fsWrite",' +
  '"fsScope","notify","presentApproval"],' +
  '"unavailable":["presentPicker","keychainGet","keychainSet","httpFetch"]}';

/** (title) => user decision — Index presents the custom approval dialog. */
export type ApprovalPresenter = (title: string,
  resolve: (approved: boolean) => void) => void;

interface BusMessage {
  type?: string;
  payload?: ProjectionEvent;
}

interface ProjectionEvent {
  kind?: string;
  index?: number;
  status?: string;
}

interface DispatchArgs {
  title?: string;
  body?: string;
}

export class HostPhase {
  private static instance: HostPhase | null = null;

  private carrierPort: number = 0;
  private capturePath: string = '';
  private started: boolean = false;
  private firstDeltaSeen: boolean = false;
  private lastDeltaIndex: number = -1;
  private nextNotificationId: number = 1;
  private approvalPresenter: ApprovalPresenter | null = null;

  static getInstance(): HostPhase {
    if (HostPhase.instance === null) {
      HostPhase.instance = new HostPhase();
    }
    return HostPhase.instance;
  }

  setApprovalPresenter(presenter: ApprovalPresenter): void {
    this.approvalPresenter = presenter;
  }

  /** Create the phase runtime (hostStart). The bus/dispatch callbacks only
   * queue or send — the one-thread rule holds (see class comment). */
  begin(ctx: common.UIAbilityContext, bundleRoot: string, capturePath: string,
    fsRoot: string): void {
    this.capturePath = capturePath;
    hostStart(bundleRoot, capturePath, fsRoot, BINDING_DESCRIPTOR,
      (line: string): void => {
        this.onBusLine(line);
      },
      (callId: number, name: string, args: string): void => {
        this.onDispatch(ctx, callId, name, args);
      });
    this.started = true;
    hilog.info(0x0000, TAG, 'phase: started, capture %{public}s', capturePath);
  }

  isStarted(): boolean {
    return this.started;
  }

  onCarrierListening(port: number): void {
    this.carrierPort = port;
    this.carrierLine('carrier.listening', {
      'transport': 'tcp', 'loopback': true, 'port': port,
    });
  }

  onStaticServed(path: string): void {
    if (path !== '/index.html') {
      return;
    }
    this.carrierLine('webclient.mounted', {
      'client': 'dsh-web-client', 'path': '/index.html',
    });
  }

  /** The page hello: mark connected, greet, then eval the entry and deliver
   * host.info — the order that pins the manifest (carrier events before the
   * scenario's first line). */
  onPageHello(protocol: string): void {
    this.carrierLine('ws.connected', { 'protocol': protocol });
    const status = hostEval(PHASE_ID, 'scenario/m5-host-binding.js');
    if (status < 0) {
      hilog.error(0x0000, TAG, 'phase: eval failed');
      return;
    }
    this.deliverEvent('{"event":"host.info","port":' + this.carrierPort + '}');
  }

  /** Page WS message: only the page hello is carrier-state; everything else
   * rides the bus seam into JS. */
  onPageText(text: string): void {
    let msg: BusMessage = {};
    try {
      msg = JSON.parse(text) as BusMessage;
    } catch (e) {
      hilog.error(0x0000, TAG, 'phase: unparsable page message');
      return;
    }
    if (msg.type === 'hello') {
      const hello = '{"type":"ws.hello","protocol":"session-projection@0"}';
      this.sendToPage(hello);
      this.onPageHello('session-projection@0');
      return;
    }
    const status = hostBusDeliver(PHASE_ID, text);
    if (status < 0) {
      hilog.error(0x0000, TAG, 'phase: bus deliver failed');
    }
  }

  /** Ability lifecycle edge (EntryAbility) → app.state channel. */
  onAppState(state: string): void {
    this.deliverEvent('{"event":"app.state","state":"' + state + '"}');
  }

  /** Notification tap (wantAgent → EntryAbility.onNewWant) → notify.response. */
  onNotifyResponse(id: string): void {
    hilog.info(0x0000, TAG, 'phase: notify response %{public}s', id);
    this.deliverEvent('{"event":"notify.response","id":"' + id + '"}');
  }

  /** One canonical carrier-side evidence line through the phase sink: the
   * SAME `dsh.spike.log: ` envelope the JS logger emits (the checker's
   * extract prefix), routed host→sink for hilog + capture. */
  private carrierLine(event: string, fields: Record<string, Object>): void {
    const payload: Record<string, Object> = {
      'scenario': SCENARIO,
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
    hostCarrierLine(PHASE_ID, 'dsh.spike.log: ' + JSON.stringify(envelope));
  }

  private deliverEvent(eventJson: string): void {
    if (!this.started) {
      return;
    }
    const status = hostEvent(PHASE_ID, eventJson);
    if (status < 0) {
      hilog.error(0x0000, TAG, 'phase: event failed: %{public}s', eventJson);
    }
  }

  private settleCall(callId: number, payloadJson: string, ok: boolean): void {
    const status = hostSettle(PHASE_ID, callId, ok, payloadJson);
    if (status < 0) {
      hilog.error(0x0000, TAG, 'phase: settle failed for call %{public}d', callId);
    }
  }

  private sendToPage(text: string): void {
    this.pageSink?.(text);
  }

  pageSink: ((text: string) => void) | null = null;

  /** JS → page direction: the __dshBusPost crossing. Ships the payload to
   * the page and keeps the token-delta / session-complete evidence current. */
  private onBusLine(line: string): void {
    let msg: BusMessage = {};
    try {
      msg = JSON.parse(line) as BusMessage;
    } catch (e) {
      return;
    }
    if (msg.type !== 'ws.send' || msg.payload === undefined) {
      return;
    }
    const payload = msg.payload;
    this.sendToPage(JSON.stringify(payload));
    if (payload.kind === 'token-delta' && typeof payload.index === 'number') {
      if (!this.firstDeltaSeen) {
        this.firstDeltaSeen = true;
        this.carrierLine('ws.token-delta', { 'first': true, 'index': payload.index });
      }
      this.lastDeltaIndex = payload.index;
    } else if (payload.kind === 'complete') {
      this.carrierLine('ws.token-delta', {
        'last': true, 'index': this.lastDeltaIndex,
      });
      this.carrierLine('ws.session-complete', { 'status': payload.status ?? 'pass' });
    }
  }

  /** Platform primitives forwarded by the C backend (never settle from
   * inside — queue work, settle on async completion). */
  private onDispatch(ctx: common.UIAbilityContext, callId: number,
    name: string, args: string): void {
    hilog.info(0x0000, TAG, 'phase: dispatch %{public}s call=%{public}d', name, callId);
    let parsed: DispatchArgs = {};
    try {
      parsed = JSON.parse(args) as DispatchArgs;
    } catch (e) {
      this.settleCall(callId,
        '{"code":"invalid","primitive":"' + name + '","message":"bad args"}', false);
      return;
    }
    if (name === 'notify') {
      this.handleNotify(ctx, callId, parsed.title ?? 'DSH', parsed.body ?? '');
    } else if (name === 'presentApproval') {
      this.handleApproval(callId, parsed.title ?? 'Approval');
    } else {
      this.settleCall(callId,
        '{"code":"invalid","primitive":"' + name + '","message":"not forwarded"}', false);
    }
  }

  private handleApproval(callId: number, title: string): void {
    const presenter = this.approvalPresenter;
    if (presenter === null) {
      this.settleCall(callId,
        '{"code":"unavailable","primitive":"presentApproval","message":"no presenter"}',
        false);
      return;
    }
    hilog.info(0x0000, TAG, 'ui-wait approval');
    presenter(title, (approved: boolean): void => {
      hilog.info(0x0000, TAG, 'ui-done approval approved=%{public}s', String(approved));
      this.settleCall(callId, '{"approved":' + String(approved) + '}', true);
    });
  }

  private handleNotify(ctx: common.UIAbilityContext, callId: number,
    title: string, body: string): void {
    const run = async (): Promise<void> => {
      hilog.info(0x0000, TAG, 'ui-wait notification-permission');
      await notificationManager.requestEnableNotification(ctx);
      hilog.info(0x0000, TAG, 'ui-done notification-permission');
      const numericId = this.nextNotificationId++;
      const id = 'n:' + numericId;
      const info: wantAgent.WantAgentInfo = {
        wants: [{
          bundleName: ctx.abilityInfo.bundleName,
          abilityName: ctx.abilityInfo.name,
          parameters: { notifyId: id },
        }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG],
      };
      const agent = await wantAgent.getWantAgent(info);
      const request: notificationManager.NotificationRequest = {
        id: numericId,
        wantAgent: agent,
        content: {
          contentType: notification.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: { title: title, text: body, additionalText: 'dsh' },
        },
      };
      await notificationManager.publish(request);
      hilog.info(0x0000, TAG, 'ui-done notify-scheduled %{public}s', id);
      this.settleCall(callId, '{"id":"' + id + '"}', true);
    };
    run().catch((err: Error): void => {
      hilog.error(0x0000, TAG, 'phase: notify failed: %{public}s', err.message ?? 'unknown');
      this.settleCall(callId,
        '{"code":"unavailable","primitive":"notify","message":"publish failed"}', false);
    });
  }

  destroy(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    hostFree(PHASE_ID);
    hilog.info(0x0000, TAG, 'phase: freed (capture %{public}s)', this.capturePath);
  }
}
