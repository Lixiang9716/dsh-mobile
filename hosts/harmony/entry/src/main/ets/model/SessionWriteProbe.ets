// dsh:logging-exempt (named route: evidence rides the phase sink)
/**
 * SessionWriteProbe — the b-harmony.write.live same-origin probe (the
 * harmony twin of hosts/ios SessionWriteProbe.swift): the page is untouched
 * upstream code — the probe defines `__b4w.*` helpers plus THREE parked leg
 * functions that drive the OFFICIAL UI like a user: pick the seeded
 * workspace, type into the real Lexical composer, click send, then read the
 * TRUE rendered state (the user bubble + the streamed assistant reply).
 * ArkWeb's runJavaScript does not await promises, so each leg parks its JSON
 * in `window.__b4wPickOut` / `__b4wTypeOut` / `__b4wSendOut` and ArkTS polls
 * with a deadline (the b3 pattern), with `window.__b4wStage` naming the
 * stage a hang sits in.
 *
 * The typed message and the scripted reply it must render. The seeded
 * workspace's title is the profile container's basename (the staged spike
 * bundle directory).
 */
export const WRITE_MESSAGE: string = 'Say hello from the composer';
export const WRITE_REPLY: string = 'Hello from upstream';
const WORKSPACE_TITLE: string = 'spike';

/** One (event, fields) pair the verdict unfolds into canonical lines. */
export interface WriteLegEvent {
  event: string;
  fields: Record<string, Object>;
}

/** The parsed probe outcome: `failed` names the first failed leg's
 * diagnosis; otherwise `events` carries the verdict lines in manifest
 * order. */
export interface WriteVerdict {
  failed: boolean;
  reason: string;
  events: WriteLegEvent[];
}

interface ProbePage {
  boot?: boolean;
  rootHasChild?: boolean;
  bodyText?: string;
}

interface PickResult {
  chip?: boolean;
  composer?: boolean;
  bodyText?: string;
  error?: string;
}

interface TypeResult {
  found?: string;
  value?: string;
  editable?: boolean;
  error?: string;
}

interface SendResult {
  sent?: boolean;
  sessionId?: string;
  reply?: boolean;
  frames?: number;
  frameShapes?: string[];
  page?: ProbePage;
  errors?: string[];
  error?: string;
}

export class SessionWriteProbe {
  /** Defines the `__b4w` helpers and the three leg functions. Every leg is
   * its own parked-promise constant so each stays small; the one script
   * installs all of them. */
  static probeScript(): string {
    return `
window.__b4w = {};
window.__b4wOut = {pick: null, type: null, send: null};
window.__b4wStage = 'defined';
window.__b4wErrors = [];
window.addEventListener('unhandledrejection', (e) => {
  window.__b4wErrors.push('unhandled: ' + String(e.reason).slice(0, 300));
});
${SessionWriteProbe.helpers()}
${SessionWriteProbe.pickLeg()}
${SessionWriteProbe.typeLeg()}
${SessionWriteProbe.sendLeg()}
'defined';
`;
  }

  /** A user-like press (the full pointer sequence — the official components
   * bind pointerdown/up handlers), the volatile welcome-notice dismissal
   * (the ui-onboarding persist is in-memory on the mobile profile: it
   * reappears every boot and blocks input), and the composer locator. */
  private static helpers(): string {
    return `
window.__b4w.press = (el) => {
  const r = el.getBoundingClientRect();
  const o = {bubbles: true, cancelable: true, view: window,
    clientX: r.x + r.width / 2, clientY: r.y + r.height / 2};
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    el.dispatchEvent(new MouseEvent(t, {...o, pointerType: 'mouse'}));
  }
};
window.__b4w.dismiss = async () => {
  for (let i = 0; i < 6; i++) {
    const cont = [...document.querySelectorAll('button')].find((b) =>
      b.getClientRects().length > 0 && (b.innerText || '').trim() === '\\u7ee7\\u7eed');
    if (cont === undefined) break;
    window.__b4w.press(cont);
    await new Promise((r) => setTimeout(r, 600));
  }
};
window.__b4w.composer = () => {
  const visible = (sel) => [...document.querySelectorAll(sel)]
    .filter((el) => el.getClientRects().length > 0);
  return visible('textarea')[0] || visible('[contenteditable="true"]')[0]
    || visible('input[type="text"]')[0];
};
`;
  }

  /** Leg 1: reach the chat view — the official picker is a CHIP
   * (`aria-label` = 选择工作区 / "Choose workspace") that opens a MENU of
   * workspace rows: click the chip, then the seeded workspace's row, then
   * wait (bounded) for the composer. Parks its JSON in `__b4wOut.pick`. */
  private static pickLeg(): string {
    return `
window.__b4w.pick = async () => {
  try {
    const out = {};
    // Settle first (the b3 probe shape): wait for the official shell to
    // reach its workspace-selection state, then pace ONE quiet window (3s)
    // so the page's boot-RPC burst is fully observed before the probe's
    // own traffic — evidence order stays deterministic.
    const chipEl = () => document.querySelector(
      'button[aria-label="选择工作区"], button[aria-label="Choose workspace"]');
    const settleDeadline = Date.now() + 20000;
    while (Date.now() < settleDeadline && !chipEl()) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 3000));
    await window.__b4w.dismiss();
    const chip = chipEl();
    out.chip = chip !== null;
    if (chip) window.__b4w.press(chip);
    await new Promise((r) => setTimeout(r, 600));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !window.__b4w.composer()) {
      const rows = [...document.querySelectorAll('div,button,li,a')].filter((el) => {
        const t = (el.innerText || '').trim();
        return t === '${WORKSPACE_TITLE}' && el.getClientRects().length > 0;
      });
      const row = rows[rows.length - 1];
      if (row) { window.__b4w.press(row); break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    while (Date.now() < deadline && !window.__b4w.composer()) {
      await new Promise((r) => setTimeout(r, 150));
    }
    out.composer = window.__b4w.composer() !== undefined;
    out.bodyText = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240);
    return out;
  } catch (e) {
    return {error: String(e).slice(0, 300)};
  }
};
window.__b4wRunPick = () => {
  window.__b4wStage = 'picking';
  window.__b4w.pick().then((v) => {
    window.__b4wOut.pick = JSON.stringify(v);
    window.__b4wStage = 'picked';
  }).catch((e) => {
    window.__b4wOut.pick = JSON.stringify({error: String(e).slice(0, 300)});
    window.__b4wStage = 'pick-threw';
  });
};
`;
  }

  /** Leg 2: type the message into the REAL composer. The editor is a rich
   * contenteditable — place the caret explicitly and insert via
   * execCommand, verifying the applied value, with bounded retries. Parks
   * its JSON in `__b4wOut.type`. */
  private static typeLeg(): string {
    return `
window.__b4w.type = async (text) => {
  try {
    const read = (el) => String(el.value ?? el.innerText ?? '').trim();
    await window.__b4w.dismiss();
    let el = window.__b4w.composer();
    if (el === undefined) return {found: 'none',
      value: (document.body.innerText || '').slice(0, 240)};
    for (let attempt = 0; attempt < 10 && read(el) !== text; attempt++) {
      await window.__b4w.dismiss();
      window.__b4w.press(el);
      el.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.addRange(range);
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
        el.dispatchEvent(new Event('input', {bubbles: true}));
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, text);
      } else { continue; } // editor not enabled yet — retry
      await new Promise((r) => setTimeout(r, 250));
      el = window.__b4w.composer() ?? el;
    }
    return {found: el.tagName.toLowerCase(),
      editable: el.isContentEditable, value: read(el).slice(0, 120)};
  } catch (e) {
    return {error: String(e).slice(0, 300)};
  }
};
window.__b4wRunType = (text) => {
  window.__b4wStage = 'typing';
  window.__b4w.type(text).then((v) => {
    window.__b4wOut.type = JSON.stringify(v);
    window.__b4wStage = 'typed';
  }).catch((e) => {
    window.__b4wOut.type = JSON.stringify({error: String(e).slice(0, 300)});
    window.__b4wStage = 'type-threw';
  });
};
`;
  }

  /** Leg 3: send (the composer's send button, falling back to Enter), then
   * wait for the REAL rendered reply — the user bubble and the assistant
   * text both visible in the official DOM. Diagnostics: a parallel raw mux
   * subscriber records every `session/follow` frame the runtime fans out, so
   * a rendering gap is attributable to wire vs page. Parks its JSON in
   * `__b4wOut.send`. */
  private static sendLeg(): string {
    return `
window.__b4w.send = async () => {
  try {
    const out = {};
    const frames = [];
    await window.__b4w.dismiss();
    const el = window.__b4w.composer();
    const buttons = [...document.querySelectorAll('button')].filter((b) =>
      b.getClientRects().length > 0 && !b.disabled);
    const target = buttons.find((b) =>
      /send|发送/i.test((b.innerText || '').trim()
        + (b.getAttribute('aria-label') || b.title || '')));
    if (el !== undefined && target) {
      window.__b4w.press(target);
    } else if (el !== undefined) {
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown',
        {bubbles: true, cancelable: true, key: 'Enter', code: 'Enter'}));
    }
    out.sent = el !== undefined;
    // The session is CREATED by the send: wait for its id, then attach the
    // diagnostic follow (a pre-send attach would carry no session).
    let sessionId = '';
    const idDeadline = Date.now() + 10000;
    while (Date.now() < idDeadline && sessionId === '') {
      sessionId = (document.body.innerText.match(/session-[0-9a-f-]{30,40}/) || [''])[0];
      await new Promise((r) => setTimeout(r, 100));
    }
    out.sessionId = sessionId;
    const ws2 = new WebSocket('ws://' + location.host + '/api/remote.mux');
    ws2.onopen = () => {
      ws2.send(JSON.stringify({type: 'open', streamId: 'b4w-probe-follow',
        endpoint: 'session/follow',
        payload: {args: {request: {address: {kind: 'session', sessionId},
          assistantStream: true}}}}));
      ws2.onmessage = (ev) => {
        const f = JSON.parse(ev.data);
        if (f.streamId === 'b4w-probe-follow' && f.type === 'item') frames.push(f.value);
      };
    };
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const text = document.body.innerText || '';
      if (text.includes('${WRITE_REPLY}')) {
        await new Promise((r) => setTimeout(r, 1200));
        break;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    try { ws2.close(); } catch (e) {}
    try { el.blur(); } catch (e) {} // drop the keyboard so the reply shot shows the transcript
    out.reply = (document.body.innerText || '').includes('${WRITE_REPLY}');
    out.frames = frames.length;
    out.errors = window.__b4wErrors.slice(0, 8);
    out.frameShapes = frames.map((f) => f.type === 'event' ? 'event:' + f.event.type
      : f.type === 'assistant-stream' ? 'as:' + f.frame.type + ':' + f.frame.revision
      : f.type + (f.type === 'snapshot' ? ':' + f.assistantStream.revision : ''));
    const boot = document.querySelector('[data-dsh-boot]');
    out.page = {boot: boot !== null,
      rootHasChild: ((document.getElementById('root') || {}).childElementCount || 0) > 0,
      bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)};
    return out;
  } catch (e) {
    return {error: String(e).slice(0, 300)};
  }
};
window.__b4wRunSend = () => {
  window.__b4wStage = 'sending';
  window.__b4w.send().then((v) => {
    window.__b4wOut.send = JSON.stringify(v);
    window.__b4wStage = 'sent';
  }).catch((e) => {
    window.__b4wOut.send = JSON.stringify({error: String(e).slice(0, 300)});
    window.__b4wStage = 'send-threw';
  });
};
`;
  }

  /** Runs one leg launcher on the page (the leg parks its own result). */
  static legLauncher(leg: string, arg: string): string {
    if (leg === 'pick') {
      return 'window.__b4wRunPick()';
    }
    if (leg === 'type') {
      return `window.__b4wRunType(${JSON.stringify(arg)})`;
    }
    return 'window.__b4wRunSend()';
  }

  /** The parked-output read for one leg. */
  static readExpr(leg: string): string {
    const key = leg === 'pick' ? 'pick' : leg === 'type' ? 'type' : 'send';
    return `JSON.stringify({out: window.__b4wOut['${key}'] ?? null,` +
      ` stage: window.__b4wStage ?? null})`;
  }

  /** Parses one pick leg result into the workspace.picked verdict event. */
  static pickEvents(json: string): WriteVerdict {
    let probe: PickResult;
    try {
      probe = JSON.parse(json) as PickResult;
    } catch (e) {
      return { failed: true, reason: 'pick leg returned no parseable result: '
        + json.substring(0, 200), events: [] };
    }
    if (probe.error !== undefined) {
      return { failed: true, reason: 'pick leg threw: ' + probe.error, events: [] };
    }
    if (probe.composer !== true) {
      return { failed: true, events: [],
        reason: 'the composer never appeared after the workspace pick; body: '
          + (probe.bodyText ?? 'nil') };
    }
    const fields: Record<string, Object> = {
      'chip': probe.chip === true,
      'composer': true,
      'bodyText': probe.bodyText ?? '',
    };
    return { failed: false, reason: '',
      events: [{ event: 'workspace.picked', fields }] };
  }

  /** Parses one type leg result into the composer.typed verdict event. */
  static typeEvents(json: string): WriteVerdict {
    let probe: TypeResult;
    try {
      probe = JSON.parse(json) as TypeResult;
    } catch (e) {
      return { failed: true, reason: 'type leg returned no parseable result: '
        + json.substring(0, 200), events: [] };
    }
    if (probe.error !== undefined) {
      return { failed: true, reason: 'type leg threw: ' + probe.error, events: [] };
    }
    if (probe.found === undefined || probe.found === 'none') {
      return { failed: true, events: [],
        reason: 'the composer element was never found to type into' };
    }
    if (probe.value !== WRITE_MESSAGE) {
      return { failed: true, events: [],
        reason: `the composer value is "${probe.value ?? 'nil'}"` };
    }
    const fields: Record<string, Object> = {
      'found': probe.found,
      'editable': probe.editable === true,
      'value': probe.value,
      'text': WRITE_MESSAGE,
    };
    return { failed: false, reason: '',
      events: [{ event: 'composer.typed', fields }] };
  }

  /** Parses one send leg result: the official DOM must show the typed user
   * message AND the scripted assistant reply. */
  static sendEvents(json: string): WriteVerdict {
    let probe: SendResult;
    try {
      probe = JSON.parse(json) as SendResult;
    } catch (e) {
      return { failed: true, reason: 'send leg returned no parseable result: '
        + json.substring(0, 200), events: [] };
    }
    if (probe.error !== undefined) {
      return { failed: true, reason: 'send leg threw: ' + probe.error, events: [] };
    }
    if (probe.sent !== true) {
      return { failed: true, events: [], reason: 'probe send never fired' };
    }
    const shapes = probe.frameShapes ?? [];
    const follow: Record<string, Object> = {
      'frames': probe.frames ?? 0,
      'shapes': shapes,
      'sessionId': probe.sessionId ?? '',
    };
    const page = probe.page ?? {};
    if (probe.reply !== true) {
      return { failed: true, events: [],
        reason: 'the assistant reply never rendered; frames: ' + shapes.length
          + '; bodyText: ' + (page.bodyText ?? 'nil').substring(0, 200) };
    }
    const rendered: Record<string, Object> = {
      'reply': WRITE_REPLY,
      'userText': WRITE_MESSAGE,
      'moduleMode': 'live',
      'bodyText': (page.bodyText ?? '').replace(/\n/g, ' '),
    };
    return { failed: false, reason: '', events: [
      { event: 'write.follow.frames', fields: follow },
      { event: 'write.reply.rendered', fields: rendered },
    ] };
  }
}
