// dsh:logging-exempt (the drive's canonical lines route through the phase
// sink via hostCarrierLine — ONE writer; hilog lines here are operator
// progress, not log events)
/**
 * NextWebPhase — drives `harmony.nextweb.mount`: the SELF-HOSTED web client
 * (presentation/web-client-next, staged at rawfile webclient/
 * dsh-web-client-next) on the SAME OfficialServe seat the release boot
 * runs — selected by dist root, zero injection rows, the same /api +
 * remote.mux surface, the INTERACTIVE config (commands + skills + the
 * CREATION row). The probe drives OUR page like a user (new session →
 * type → send → stop → create) through REAL agent-loop turns whose model
 * boundary is the seat's scripted route (the SLOW_TURN drip and the
 * CREATE_TURN write+present round ride the marker scripts); the journal
 * streams live and the page's own timeline fold renders it. HarmonyOS
 * sibling of hosts/ios NextWebRuntime and hosts/android NextWebSession —
 * the ArkWeb shape: legs are page-side async functions that park their
 * JSON result in `window.__nextOut` (runJavaScript cannot await a
 * promise), polled with a deadline (rules.md rule 8).
 */
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { hostCarrierLine } from 'libspike.so';
import { OfficialServe, NEXT_CLIENT_ROOT } from './OfficialServe';

const TAG: string = 'dsh.app';
const SCENARIO: string = 'harmony.nextweb.mount';
/** The typed messages and the reply fragment the drive waits for — the
 * scripted route's pair; the second message carries SLOW_TURN (the drip
 * marker), the third CREATE_TURN (the write+present round). */
const MESSAGE_TEXT: string = 'Say hello from the next client';
const CANCEL_TEXT: string = 'SLOW_TURN keep going';
const CREATE_TEXT: string = 'CREATE_TURN 请创建一只游动的蓝色鲸鱼';
const EXPECTED_REPLY: string = 'Hello from upstream';
const CARD_TITLE: string = '游动的蓝色鲸鱼 — 点按全屏查看';
const CANARY: string = 'BLUE-WHALE-CANARY';
/** The leg calls (template-literal-free — the texts ride quoted strings). */
const TYPE_CALL: string = "window.__next.type('Say hello from the next client')";
const CANCEL_CALL: string = "window.__next.cancel('SLOW_TURN keep going')";
const CARD_CALL: string =
  "window.__next.card('CREATE_TURN 请创建一只游动的蓝色鲸鱼')";
const REPLY_CALL: string = "window.__next.reply('Hello from upstream')";

/** One parked leg result (the probe's JSON, parsed). */
interface LegOut {
  leg?: string;
  chatVisible?: boolean;
  found?: boolean;
  sendEnabled?: boolean;
  pressed?: boolean;
  settled?: boolean;
  stopShown?: boolean;
  stopPressed?: boolean;
  toast?: string;
  creationCard?: boolean;
  open?: boolean;
  srcdoc?: string;
  title?: string;
  items?: number;
  fail?: string;
  dump?: string;
}

export class NextWebPhase {
  private static instance: NextWebPhase | null = null;

  private serve: OfficialServe = new OfficialServe();
  private finished = false;
  private probeStarted = false;
  private assetLogged = false;
  private upgradeLogged = false;
  private attachLogged = false;
  private frameLogged = false;
  private rpcLogged: Set<string> = new Set();

  /** Index wires the ArkWeb controller through this (the origin open). */
  openOrigin: (url: string) => void = (url: string): void => {};

  static getInstance(): NextWebPhase {
    if (NextWebPhase.instance === null) {
      NextWebPhase.instance = new NextWebPhase();
    }
    return NextWebPhase.instance;
  }

  /** Boots the drive: the serving facts → canonical records, then the
   * INTERACTIVE seat over the next client's staged web dir (no credential —
   * the scripted route answers, E2E determinism, logged as such). */
  begin(ctx: common.UIAbilityContext, webRoot: string, capturePath: string,
    fsRoot: string): void {
    this.wireEvidence();
    this.serve.onOrigin = (url: string): void => {
      this.openOrigin(url);
    };
    this.serve.beginInteractive(ctx, webRoot, capturePath, fsRoot, null,
      NEXT_CLIENT_ROOT);
  }

  /** The evidence seam: the seat's serving facts → the manifest's records. */
  private wireEvidence(): void {
    this.serve.onCarrierUp = (port: number): void => {
      this.carrierLine('client.selected', {
        'client': 'dsh-web-client-next', 'source': 'launch',
      });
      hilog.info(0x0000, TAG, 'nextweb: carrier up on %{public}d', port);
    };
    this.serve.onIndexRendered = (rows: number, bytes: number): void => {
      this.carrierLine('index.rendered', { 'rows': rows, 'bytes': bytes });
    };
    this.serve.onIndexServed = (): void => {
      this.carrierLine('index.served', { 'path': '/', 'status': 200 });
    };
    this.serve.onAssetServed = (path: string): void => {
      if (this.assetLogged || path !== '/js/main.js') {
        return;
      }
      this.assetLogged = true;
      this.carrierLine('asset.served', { 'path': path });
    };
    this.serve.onUpgradeAccepted = (path: string): void => {
      if (this.upgradeLogged) {
        return;
      }
      this.upgradeLogged = true;
      this.carrierLine('upgrade.accepted', { 'path': path });
    };
    this.serve.onAPICall = (endpoint: string, answered: string): void => {
      if (this.rpcLogged.has(endpoint)) {
        return;
      }
      this.rpcLogged.add(endpoint);
      this.carrierLine('rpc.observed', {
        'endpoint': endpoint, 'answered': answered,
      });
    };
    this.serve.onMuxFrame = (direction: string, kind: string): void => {
      this.observeFrame(direction, kind);
    };
  }

  /** session.attached: the page's journal stream opened; the next tx item is
   * the first forwarded frame (both pinned once — the baseline races the
   * probe's DOM phases by construction, order:any in the manifest). */
  private observeFrame(direction: string, kind: string): void {
    if (direction !== 'tx' || kind !== 'item') {
      return;
    }
    if (!this.attachLogged) {
      this.attachLogged = true;
      this.carrierLine('session.attached', { 'stream': 'session/follow' });
      return;
    }
    if (!this.frameLogged) {
      this.frameLogged = true;
      this.carrierLine('journal.frame.forwarded', {
        'direction': 'tx', 'first': true,
      });
    }
  }

  destroy(): void {
    this.serve.destroy();
    NextWebPhase.instance = null;
  }

  /** Index's teardown: a null instance means the leg never ran. */
  static destroyIfLive(): void {
    if (NextWebPhase.instance !== null) {
      NextWebPhase.instance.destroy();
    }
  }

  // ---- the page drive -------------------------------------------------------

  /** The document finished loading: ONE drive chain per launch; wait for the
   * entry-module evidence, install the probe, run the legs in order (a flat
   * chain — each step validates the previous leg's verdict, emits its
   * record, and starts the next leg; any failure lands in the catch). */
  onPageFinished(runJs: (script: string) => Promise<string>): void {
    if (this.finished || this.probeStarted) {
      return;
    }
    this.probeStarted = true;
    const deadline: number = Date.now() + 30000;
    const waitForEntry = (): void => {
      if (this.assetLogged) {
        this.driveChain(runJs);
        return;
      }
      if (Date.now() > deadline) {
        this.finish(false, 'the entry module never arrived');
        return;
      }
      setTimeout((): void => waitForEntry(), 200);
    };
    waitForEntry();
  }

  /** Runs one leg and polls its parked result until the leg tag matches. */
  private runLeg(runJs: (script: string) => Promise<string>, call: string,
    leg: string, timeoutMs: number): Promise<LegOut | null> {
    return runJs(call).then((): Promise<LegOut | null> => {
      return this.pollLeg(runJs, leg, Date.now() + timeoutMs, '');
    });
  }

  private pollLeg(runJs: (script: string) => Promise<string>, leg: string,
    deadline: number, last: string): Promise<LegOut | null> {
    // runJavaScript returns the expression's value JSON-encoded — and
    // window.__nextOut is itself a JSON STRING (the leg parked it), so the
    // payload is double-encoded: unwrap once, then parse the leg object.
    return runJs('window.__nextOut ?? \'\'').then((json: string):
      Promise<LegOut | null> => {
      let out: LegOut | null = null;
      try {
        const raw = JSON.parse(json) as string;
        const parsed = JSON.parse(raw) as LegOut | null;
        if (parsed !== null && parsed.leg === leg) {
          out = parsed;
        }
      } catch (e) {
        out = null;
      }
      if (out !== null) {
        return Promise.resolve(out);
      }
      if (Date.now() > deadline) {
        throw new Error('leg ' + leg + ' timed out — last: ' + last);
      }
      // PACE the retry (300ms): a tight runJavaScript loop starves the
      // ArkTS main thread — the carrier's socket callbacks with it — and
      // the scripted turn's own fetch times out (measured: the mock route
      // hung 30s while the reply poll spun). The b3 probe's interval,
      // mirrored.
      return new Promise<LegOut | null>((resolve, reject): void => {
        setTimeout((): void => {
          this.pollLeg(runJs, leg, deadline, json.slice(0, 200))
            .then(resolve, reject);
        }, 300);
      });
    });
  }

  private driveChain(runJs: (script: string) => Promise<string>): void {
    runJs(NEXT_PROBE_SCRIPT).then((): Promise<LegOut | null> => {
      return this.runLeg(runJs, 'window.__next.open()', 'open', 30000);
    }).then((out): Promise<LegOut | null> => {
      if (out === null || out.chatVisible !== true) {
        throw new Error('the chat view never appeared');
      }
      this.carrierLine('client.opened', { 'chatVisible': true });
      return this.runLeg(runJs, TYPE_CALL, 'type', 15000);
    }).then((out): Promise<LegOut | null> => {
      if (out === null || out.found !== true || out.sendEnabled !== true) {
        throw new Error('the composer never took the message');
      }
      this.carrierLine('composer.typed', {
        'found': true, 'sendEnabled': true, 'text': MESSAGE_TEXT,
      });
      return this.runLeg(runJs, 'window.__next.send()', 'sent', 15000);
    }).then((out): Promise<LegOut | null> => {
      if (out === null || out.pressed !== true) {
        throw new Error('probe send never fired');
      }
      return this.runLeg(runJs, REPLY_CALL, 'reply', 60000);
    }).then((out): Promise<LegOut | null> => {
      if (out === null || out.settled !== true) {
        throw new Error('the first turn never settled');
      }
      this.carrierLine('page.rendered', {
        'reply': EXPECTED_REPLY, 'userText': MESSAGE_TEXT,
      });
      return this.runLeg(runJs, CANCEL_CALL, 'cancel', 60000);
    }).then((out): Promise<LegOut | null> => {
      if (out === null || (out.fail ?? '') !== '') {
        throw new Error('the cancel leg failed: ' +
          (out !== null ? (out.fail ?? 'no result') : 'no result'));
      }
      if (out.stopShown !== true || out.stopPressed !== true) {
        throw new Error('the stop affordance never appeared mid-drip');
      }
      this.carrierLine('cancel.stop.pressed', {
        'stopShown': true, 'stopPressed': true,
      });
      if (out.toast !== '已请求停止') {
        throw new Error('the cancel never settled (toast: ' + out.toast + ')');
      }
      this.carrierLine('cancel.settled', { 'accepted': true });
      return this.runLeg(runJs, CARD_CALL, 'card', 90000);
    }).then((out): Promise<LegOut | null> => {
      if (out === null || (out.fail ?? '') !== '') {
        throw new Error('the creation leg failed: ' +
          (out !== null ? (out.fail ?? 'no result') : 'no result') +
          ' (dump: ' + (out !== null ? (out.dump ?? '') : '') + ')');
      }
      if (out.creationCard !== true) {
        throw new Error('the creation card never rendered');
      }
      this.carrierLine('creation.card.rendered', {
        'title': CARD_TITLE, 'items': out.items ?? 0,
      });
      return this.runLeg(runJs, 'window.__next.viewer()', 'viewer', 45000);
    }).then((out): void => {
      if (out === null || out.open !== true ||
        !(out.srcdoc ?? '').includes(CANARY)) {
        throw new Error('the creation viewer never carried the file');
      }
      this.carrierLine('creation.opened', { 'srcdocContains': CANARY });
      this.finish(true, '');
    }).catch((err: Error): void => {
      this.finish(false, err.message ?? 'unknown');
    });
  }

  // ---- settling ---------------------------------------------------------------

  private finish(passed: boolean, error: string): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    hilog.info(0x0000, TAG, 'nextweb: verdict %{public}s (%{public}s)',
      passed ? 'PASS' : 'FAIL', error);
    hostCarrierLine(2, 'dsh.spike.verdict: ' + SCENARIO +
      (passed ? ' PASS | quickjs-ng 0.17.0' : ' FAIL | ' + error));
    hostCarrierLine(2, 'dsh.spike.result: ALL ' + (passed ? 'PASS' : 'FAIL'));
  }

  private carrierLine(event: string, fields: Record<string, Object>): void {
    const payload: Record<string, Object> = {
      'scenario': SCENARIO,
      'event': event,
    };
    const keys: string[] = Object.keys(fields);
    for (let i = 0; i < keys.length; i++) {
      payload[keys[i]] = fields[keys[i]];
    }
    const envelope: Record<string, Object> = {
      'level': 'info',
      'module': 'dsh.carrier',
      'message': 'e2e',
      'data': [payload] as Object[],
    };
    hostCarrierLine(2, 'dsh.spike.log: ' + JSON.stringify(envelope));
  }
}

/** The `__next` probe legs (page-side async functions with their own bounded
 * waits — ArkWeb keeps page timers live; every leg parks exactly ONE result
 * in `window.__nextOut` and legs never nest). */
const NEXT_PROBE_SCRIPT: string = `
window.__next = {};
window.__next.wait = async (condition, deadlineMs) => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline && !condition()) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return condition();
};
window.__next.open = async () => {
  const out = {leg: 'open'};
  out.chatVisible = await window.__next.wait(() => {
    const chat = document.getElementById('view-chat');
    if (chat && !chat.hidden) return true;
    const button = document.getElementById('new-session');
    if (button) button.click();
    return false;
  }, 20000);
  window.__nextOut = JSON.stringify(out);
};
window.__next.type = async (text) => {
  const out = {leg: 'type'};
  const send = document.getElementById('composer-send');
  const input = document.getElementById('composer-input');
  if (!input) {
    out.found = false;
    window.__nextOut = JSON.stringify(out);
    return;
  }
  out.found = true;
  out.sendEnabled = await window.__next.wait(() => {
    input.value = text;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    return !!send && !send.disabled;
  }, 15000);
  window.__nextOut = JSON.stringify(out);
};
window.__next.send = async () => {
  const send = document.getElementById('composer-send');
  const out = {leg: 'sent', pressed: !!send};
  if (send) send.click();
  window.__nextOut = JSON.stringify(out);
};
window.__next.reply = async (expect) => {
  const out = {leg: 'reply'};
  const read = () => {
    const host = document.getElementById('transcript');
    const assistant = host.querySelector('.item-assistant .md');
    return {
      userShown: host.querySelector('.user-bubble') !== null,
      tailPresent: host.querySelector('.tail-state') !== null,
      assistant: assistant ? assistant.textContent : '',
    };
  };
  out.settled = await window.__next.wait(() => {
    const state = read();
    return state.userShown && !state.tailPresent && state.assistant.includes(expect);
  }, 55000);
  window.__nextOut = JSON.stringify(out);
};
window.__next.cancel = async (text) => {
  const out = {leg: 'cancel'};
  const send = document.getElementById('composer-send');
  const input = document.getElementById('composer-input');
  const toast = () => (document.getElementById('toast')?.textContent || '');
  const typed = await window.__next.wait(() => {
    input.value = text;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    return !!send && !send.disabled;
  }, 15000);
  if (!typed) {
    out.fail = 'the composer never took the slow prompt';
    window.__nextOut = JSON.stringify(out);
    return;
  }
  send.click();
  out.stopShown = await window.__next.wait(
    () => send.classList.contains('stop'), 25000);
  if (out.stopShown) send.click();
  out.stopPressed = out.stopShown;
  const settled = await window.__next.wait(
    () => toast() === '已请求停止', 40000);
  out.toast = settled ? '已请求停止' : toast();
  window.__nextOut = JSON.stringify(out);
};
window.__next.cancelState = () => {
  const send = document.getElementById('composer-send');
  const dbg = window.__dshComposerDebug ? window.__dshComposerDebug() : {};
  return {stop: !!send && send.classList.contains('stop'),
    optimistic: dbg.optimistic === true};
};
window.__next.card = async (text) => {
  const out = {leg: 'card'};
  const send = document.getElementById('composer-send');
  const input = document.getElementById('composer-input');
  const quiet = await window.__next.wait(() => {
    const s = window.__next.cancelState();
    return !s.stop && !s.optimistic;
  }, 40000);
  if (!quiet) {
    out.fail = 'the composer never left its stop state';
    window.__nextOut = JSON.stringify(out);
    return;
  }
  const typed = await window.__next.wait(() => {
    input.value = text;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    return !!send && !send.disabled;
  }, 15000);
  if (!typed) {
    out.fail = 'the composer never took the create prompt';
    window.__nextOut = JSON.stringify(out);
    return;
  }
  send.click();
  out.creationCard = await window.__next.wait(
    () => document.querySelector('.creation-card') !== null, 75000);
  if (!out.creationCard) {
    const host = document.getElementById('transcript');
    out.dump = [...host.querySelectorAll('.item, .group')]
      .map((n) => (n.className.split(' ')[0] || 'div') + ':' +
        n.textContent.replace(/\\s+/g, ' ').slice(0, 60)).join(' | ').slice(0, 600);
  }
  window.__nextOut = JSON.stringify(out);
};
window.__next.viewer = async () => {
  const out = {leg: 'viewer'};
  const card = document.querySelector('.creation-card');
  if (card) card.click();
  const read = () => {
    const frame = document.getElementById('creation-frame');
    const view = document.getElementById('creation-view');
    return {open: !!view && !view.hidden, srcdoc: frame ? frame.srcdoc : ''};
  };
  await window.__next.wait(
    () => { const s = read(); return s.open && s.srcdoc.length > 0; }, 40000);
  const state = read();
  Object.assign(out, state);
  window.__nextOut = JSON.stringify(out);
};
'defined';
`;
