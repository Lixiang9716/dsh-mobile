// dsh:logging-exempt (hilog here is drive/progress evidence only; canonical
// lines belong to the runtime's mounted logger — the KeychainPrimitives face)
import { hilog } from '@kit.PerformanceAnalysisKit';

/**
 * TimerPrimitive — the gateway timer seam (contract v1.4.0 §5) on this host:
 * `timerSchedule` arms an ArkTS-side timeout and answers `{timerId}`
 * immediately (the JS shim's sync-handle contract); when the timeout fires,
 * a `timer.fire` event is delivered onto the runtime's gateway event channel
 * (the same seam http.body rides — the host dispatches it onto the serial
 * runtime queue, so a timer callback never runs on a second thread).
 * `timerCancel` is the idempotent one-way cancel the contract defines.
 *
 * The consumer is runtime/dsh/upstream/shims/timers.js: the vendored
 * runtime's deadline fuses, the llm retry pacing and the read-idle watchdog
 * all arm through it. Before this primitive the gateway answered the arm
 * with `invalid` — the shim warned once per runtime and every timer hung
 * forever (measured 2026-10-05: an llm request timeout scheduled its retry
 * and the retry never ran).
 *
 * Threading (ARCHITECTURE.md §6): the ArkTS setTimeout callback runs on the
 * UIAbility's event loop and only calls deliverEvent — the runtime queue is
 * never reentered from here.
 */
const TAG: string = 'dsh.timer';

export class TimerPrimitive {
  private readonly deliver: EventSink;
  private readonly timeouts: Map<number, number> = new Map(); // gateway timerId -> ArkTS timeout id
  private nextTimerId: number = 1;

  constructor(deliver: EventSink) {
    this.deliver = deliver;
  }

  /** `timerSchedule {delayMs, tag?}` — arm and answer `{timerId}`. */
  schedule(callId: number, args: string, settle: SettleFn): void {
    hilog.debug(0x0000, TAG, 'timerSchedule call=%{public}d', callId);
    let parsed: Record<string, Object> = {};
    try {
      parsed = JSON.parse(args) as Record<string, Object>;
    } catch (e) {
      settle(callId, '{"code":"invalid","primitive":"timerSchedule","message":"bad args"}', false);
      return;
    }
    const requested = parsed.delayMs;
    const delayMs: number = typeof requested === 'number'
      ? Math.min(2147483647, Math.max(0, Math.trunc(requested)))
      : 0;
    const timerId: number = this.nextTimerId++;
    const arktsId: number = setTimeout((): void => {
      this.timeouts.delete(timerId);
      this.deliver('{"event":"timer.fire","timerId":' + timerId + '}');
    }, delayMs);
    this.timeouts.set(timerId, arktsId);
    hilog.info(0x0000, TAG, 'timer armed id=%{public}d delay=%{public}d', timerId, delayMs);
    settle(callId, '{"timerId":' + timerId + '}', true);
  }

  /** `timerCancel {timerId}` — idempotent: an unknown or already-fired id
   * still settles ok. */
  cancel(callId: number, args: string, settle: SettleFn): void {
    hilog.debug(0x0000, TAG, 'timerCancel call=%{public}d', callId);
    let parsed: Record<string, Object> = {};
    try {
      parsed = JSON.parse(args) as Record<string, Object>;
    } catch (e) {
      settle(callId, '{"code":"invalid","primitive":"timerCancel","message":"bad args"}', false);
      return;
    }
    const requested = parsed.timerId;
    const timerId: number = typeof requested === 'number' ? requested : -1;
    const arktsId = this.timeouts.get(timerId);
    if (arktsId !== undefined) {
      clearTimeout(arktsId);
      this.timeouts.delete(timerId);
    }
    hilog.info(0x0000, TAG, 'timer cancelled id=%{public}d', timerId);
    settle(callId, '{"cancelled":true}', true);
  }
}

type EventSink = (eventJson: string) => void;
type SettleFn = (callId: number, payloadJson: string, ok: boolean) => void;
