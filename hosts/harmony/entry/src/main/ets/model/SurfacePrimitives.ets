// dsh:logging-exempt (hilog here is drive/progress evidence only; canonical
// lines belong to the runtime's mounted logger)
import { hilog } from '@kit.PerformanceAnalysisKit';

/**
 * SurfacePrimitives — the render surface (contract v1.10.0) on this host:
 * `presentSurface` opens the Index-hosted native overlay (a fullscreen
 * Canvas above the Web seat — real ArkTS rendering, never a WebView),
 * `surfaceDraw` interprets the closed `surface.ops@1` vocabulary onto the
 * overlay's CanvasRenderingContext2D, `closeSurface` closes it. The frame
 * pump is interval-scheduled at ~30 Hz while armed (`animate: true` on the
 * last draw) and silent otherwise — the contract's descriptor-prose rule;
 * touch events ride `surface.input` on the same event sink timer.fire
 * uses (the serial queue is never reentered, §6).
 *
 * The view seam follows the ApprovalDialog precedent: the Index page
 * registers a presenter (open/submit/close callbacks); this model never
 * touches UI itself, so the threading rules hold (every callback only
 * queues or posts).
 *
 * v0 boundary (recorded here, not hidden): `drawImage` rejects `invalid`
 * naming itself — the op is in the frozen vocabulary, this host serves it
 * with its first consumer (the pomodoro arc needs none of it).
 */
const TAG: string = 'dsh.surface';

/** The frame the view renders: one validated op list + its sequence. */
export interface SurfaceFrame {
  ops: string; // JSON array of surface.ops@1 ops, validated
  seq: number | null;
}

/** The view seam Index registers - three plain callbacks (the approval
 * presenter's function-parameter pattern; ArkTS rejects object literals
 * with function members). open resolves dims on screen, null on user
 * dismissal; submit pushes one frame; close is idempotent. */
export type SurfaceOpenFn = (title: string,
  onResult: (dims: SurfaceDims | null) => void) => void;
export type SurfaceSubmitFn = (frame: SurfaceFrame) => void;
export type SurfaceCloseFn = () => void;

export interface SurfaceDims {
  width: number;
  height: number;
  scale: number;
}

type EventSink = (eventJson: string) => void;
type SettleFn = (callId: number, payloadJson: string, ok: boolean) => void;

const PUMP_INTERVAL_MS = 32; // ~30 Hz, interval-scheduled (descriptor prose)

interface PathOp {
  c?: string;
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
  r?: number;
  start?: number;
  end?: number;
  ccw?: boolean;
}

interface DrawOpRow {
  op?: string;
  color?: string;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  font?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  text?: string;
  baseline?: string;
  path?: string;
  d?: PathOp[];
}

export class SurfacePrimitives {
  private readonly deliver: EventSink;
  private openFn: SurfaceOpenFn | null = null;
  private submitFn: SurfaceSubmitFn | null = null;
  private closeFn: SurfaceCloseFn | null = null;
  private surfaceId: string | null = null;
  private nextId: number = 1;
  private pumpTimer: number = -1;
  private droppedWhilePumping: number = 0;

  constructor(deliver: EventSink) {
    this.deliver = deliver;
  }

  setView(open: SurfaceOpenFn, submit: SurfaceSubmitFn,
    close: SurfaceCloseFn): void {
    this.openFn = open;
    this.submitFn = submit;
    this.closeFn = close;
  }

  /** `presentSurface {kind, title?}` — open the overlay, answer dims. */
  present(callId: number, args: string, settle: SettleFn): void {
    hilog.debug(0x0000, TAG, 'presentSurface call=%{public}d', callId);
    if (this.openFn === null) {
      settle(callId, '{"code":"unavailable","primitive":"presentSurface",' +
        '"message":"no surface presenter on this seat"}', false);
      return;
    }
    let parsed: Record<string, Object> = {};
    try {
      parsed = JSON.parse(args) as Record<string, Object>;
    } catch (e) {
      settle(callId, '{"code":"invalid","primitive":"presentSurface","message":"bad args"}', false);
      return;
    }
    if (parsed.kind !== 'canvas2d') {
      settle(callId, '{"code":"invalid","primitive":"presentSurface",' +
        '"message":"v0 serves kind canvas2d only"}', false);
      return;
    }
    if (this.surfaceId !== null) {
      // single-surface v0: fail-soft, the contract's posture — resolve
      // null (never queue a second surface).
      hilog.info(0x0000, TAG, 'presentSurface: one surface already open — null');
      settle(callId, 'null', true);
      return;
    }
    const id = 'sf-' + this.nextId++;
    const title = typeof parsed.title === 'string' ? parsed.title : 'DSH Surface';
    this.openFn(title, (dims: SurfaceDims | null): void => {
      if (dims === null) {
        hilog.info(0x0000, TAG, 'presentSurface dismissed id=%{public}s', id);
        settle(callId, 'null', true);
        return;
      }
      this.surfaceId = id;
      hilog.info(0x0000, TAG, 'surface open id=%{public}s %{public}d x %{public}d',
        id, dims.width, dims.height);
      settle(callId, JSON.stringify({
        surfaceId: id, width: dims.width, height: dims.height, scale: dims.scale,
      }), true);
    });
  }

  /** `surfaceDraw {surfaceId, ops, seq?, animate?}` — validate + submit. */
  draw(callId: number, args: string, settle: SettleFn): void {
    hilog.debug(0x0000, TAG, 'surfaceDraw call=%{public}d', callId);
    let parsed: Record<string, Object> = {};
    try {
      parsed = JSON.parse(args) as Record<string, Object>;
    } catch (e) {
      settle(callId, '{"code":"invalid","primitive":"surfaceDraw","message":"bad args"}', false);
      return;
    }
    if (parsed.surfaceId !== this.surfaceId || this.surfaceId === null) {
      settle(callId, '{"code":"invalid","primitive":"surfaceDraw",' +
        '"message":"unknown or closed surface"}', false);
      return;
    }
    const rows = parsed.ops;
    if (!Array.isArray(rows)) {
      settle(callId, '{"code":"invalid","primitive":"surfaceDraw","message":"ops must be an array"}', false);
      return;
    }
    const ops = rows as DrawOpRow[];
    for (let i = 0; i < ops.length; i++) {
      const why = this.opInvalid(ops[i]);
      if (why !== '') {
        settle(callId, '{"code":"invalid","primitive":"surfaceDraw","message":"op ' +
          i + ': ' + why + '"}', false);
        return;
      }
    }
    if (this.submitFn !== null) {
      this.submitFn({
        ops: JSON.stringify(ops),
        seq: typeof parsed.seq === 'number' ? parsed.seq : null,
      });
    }
    if (parsed.animate === true) {
      this.armPump();
    } else {
      this.disarmPump();
    }
    settle(callId, '{"presented":true}', true);
  }

  /** `closeSurface {surfaceId}` — idempotent. */
  close(callId: number, args: string, settle: SettleFn): void {
    hilog.debug(0x0000, TAG, 'closeSurface call=%{public}d', callId);
    let parsed: Record<string, Object> = {};
    try {
      parsed = JSON.parse(args) as Record<string, Object>;
    } catch (e) {
      settle(callId, '{"code":"invalid","primitive":"closeSurface","message":"bad args"}', false);
      return;
    }
    if (parsed.surfaceId === this.surfaceId && this.surfaceId !== null) {
      this.closeNow();
    }
    settle(callId, '{}', true);
  }

  /** The view reports the user closed the overlay (host chrome ✕). */
  onUserClosed(): void {
    this.closeNow();
  }

  /** The view reports a touch — deliver `surface.input` on the seam. */
  onTouch(kind: string, x: number, y: number): void {
    if (this.surfaceId === null) return;
    this.deliver('{"event":"surface.input","surfaceId":' +
      JSON.stringify(this.surfaceId) + ',"kind":' + JSON.stringify(kind) +
      ',"x":' + x + ',"y":' + y + '}');
  }

  private closeNow(): void {
    this.disarmPump();
    this.surfaceId = null;
    if (this.closeFn !== null) {
      this.closeFn();
    }
    hilog.info(0x0000, TAG, 'surface closed');
  }

  private armPump(): void {
    if (this.pumpTimer >= 0) return;
    this.droppedWhilePumping = 0;
    this.pumpTimer = setInterval((): void => {
      if (this.surfaceId === null) {
        this.disarmPump();
        return;
      }
      this.deliver('{"event":"surface.frame","surfaceId":' +
        JSON.stringify(this.surfaceId) + ',"timestamp":' +
        JSON.stringify(new Date().toISOString()) +
        ',"dropped":' + this.droppedWhilePumping + '}');
    }, PUMP_INTERVAL_MS);
    hilog.info(0x0000, TAG, 'frame pump armed');
  }

  private disarmPump(): void {
    if (this.pumpTimer >= 0) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = -1;
      hilog.info(0x0000, TAG, 'frame pump disarmed');
    }
  }

  /** Per-op grammar check (surface.ops@1): '' when the op parses. */
  private opInvalid(op: DrawOpRow): string {
    if (op === null || typeof op !== 'object' || typeof op.op !== 'string') {
      return 'not an op object';
    }
    const num = (v: Object | undefined): boolean => typeof v === 'number' && Number.isFinite(v);
    switch (op.op) {
      case 'clear':
        return '';
      case 'setStyle':
        return '';
      case 'fillRect':
        return num(op.x) && num(op.y) && num(op.w) && num(op.h) ? '' : 'fillRect needs numeric x/y/w/h';
      case 'strokePath':
      case 'fillPath':
        return this.pathInvalid(op.d);
      case 'text':
        return num(op.x) && num(op.y) && typeof op.text === 'string' ? '' : 'text needs numeric x/y and a string';
      case 'drawImage':
        return 'drawImage lands with its first consumer on this host (the closed vocabulary serves it; this v0 refuses loud)';
      default:
        return 'unknown op ' + op.op;
    }
  }

  private pathInvalid(d: PathOp[] | undefined): string {
    if (!Array.isArray(d) || d.length === 0) return 'd must be a non-empty array';
    if (d[0].c !== 'move') return 'd must start with move';
    for (let i = 0; i < d.length; i++) {
      const seg = d[i];
      if (seg === null || typeof seg !== 'object' || typeof seg.c !== 'string') {
        return 'd[' + i + '] is not a path command';
      }
      const num = (v: Object | undefined): boolean => typeof v === 'number' && Number.isFinite(v);
      if (seg.c === 'move' || seg.c === 'line') {
        if (!num(seg.x) || !num(seg.y)) return 'd[' + i + '] needs numeric x/y';
      } else if (seg.c === 'quad') {
        if (!num(seg.cx) || !num(seg.cy) || !num(seg.x) || !num(seg.y)) {
          return 'd[' + i + '] needs numeric cx/cy/x/y';
        }
      } else if (seg.c === 'arc') {
        if (!num(seg.x) || !num(seg.y) || !num(seg.r) || !num(seg.start) || !num(seg.end)) {
          return 'd[' + i + '] needs numeric x/y/r/start/end';
        }
      } else if (seg.c !== 'close') {
        return 'd[' + i + '] unknown command ' + seg.c;
      }
    }
    return '';
  }
}
