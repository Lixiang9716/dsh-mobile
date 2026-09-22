// dsh:logging-exempt (named route: evidence rides the phase sink)
/**
 * SessionLiveProbe — the b3 same-origin probe of harmony.session.live-read
 * (the harmony twin of hosts/ios SessionLiveProbe.swift): the page is
 * untouched upstream code — the probe defines `__b3Run`, posts the REAL
 * session.list RPC through the official envelope, attaches the mux
 * session/journal stream for the session the runtime reports, collects the
 * journal frames (the turn-1 baseline + the live turn-2 stream), and reads
 * the TRUE rendered state. ArkWeb's runJavaScript does not await promises,
 * so the probe parks its JSON in `window.__b3Out` and the drive polls (the
 * b1 pattern).
 *
 * Expected journal shape (frozen from the observed on-device runs, same
 * spine as iOS): the FIRST scripted turn's full log rides the baseline —
 * header + context folds included — and the second turn streams LIVE after
 * the attach with the shorter log. 19 frames, contiguous seqs 0..18.
 */

/** One (event, fields) pair the verdict unfolds into canonical lines. */
export interface LegEvent {
  event: string;
  fields: Record<string, Object>;
}

/** The parsed probe outcome: `failed` names the first failed leg's
 * diagnosis; otherwise `events` carries the verdict lines in manifest
 * order and the caller finishes the leg. */
export interface ProbeVerdict {
  failed: boolean;
  reason: string;
  events: LegEvent[];
}

interface ProbeJournal {
  frames?: number;
  types?: string[];
  firstSeq?: number;
  lastSeq?: number;
}

interface ProbeResult {
  shell?: string;
  rpc?: string;
  sessions?: number;
  blank?: boolean;
  running?: boolean;
  sessionId?: string;
  mux?: string;
  journal?: ProbeJournal;
  moduleMode?: string;
  page?: Record<string, Object>;
}

const BASELINE_TYPES: string = 'agent/inbox/spliced,turn/start,agent/inbox/spliced,' +
  'step/start,system/message,user/message,request/header,request/context,' +
  'assistant/message,step/end,turn/end';
const LIVE_TYPES: string = 'agent/inbox/spliced,turn/start,agent/inbox/spliced,' +
  'step/start,user/message,assistant/message,step/end,turn/end';

export class SessionLiveProbe {
  /** Defines `__b3Run` on the page. Step order: real RPC (session.list),
   * mux upgrade + journal attach for the reported session, frame collection
   * until two assistant/message events quiet down, then the rendered read.
   * The result lands in `window.__b3Out` (runJavaScript cannot await). */
  static probeScript(): string {
    return `
window.__b3Out = null;
window.__b3Stage = 'defined';
window.__b3Run = async () => {
  const out = {};
  window.__b3Stage = 'run';
  const post = (endpoint, payload) => fetch('/api/' + endpoint, {
    method: 'POST', credentials: 'same-origin',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({type: 'client-request',
      rpcId: 'b3-probe-' + endpoint + '-' + Math.random().toString(36).slice(2, 8),
      method: endpoint, payload}),
  }).then((r) => r.json());
  // Leg 0: wait (bounded) for the official shell to reach its
  // workspace-selection state, then pace ONE quiet window (3s) so the
  // UI's boot-RPC burst is fully observed before the probe's own calls.
  const shellSettle = async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const text = (document.body.innerText || '');
      if (text.includes('\\u9009\\u62e9\\u5de5\\u4f5c\\u533a')) {
        await new Promise((r) => setTimeout(r, 3000));
        return 'shell';
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return 'shell-timeout';
  };
  out.shell = await shellSettle();
  window.__b3Stage = 'shell:' + out.shell;
  // Leg 1: the REAL session.list answer + the reported session identity.
  const rpc = await post('session.list', {args: {}});
  out.rpc = rpc && rpc.type === 'server-response'
    ? (rpc.result.ok === true ? 'ok' : 'error:' + (rpc.result.error || {}).code)
    : 'malformed';
  const items = (rpc.result && rpc.result.ok && rpc.result.value && rpc.result.value.items) || [];
  out.sessions = items.length;
  out.blank = items.length > 0 ? !!items[0].blank : null;
  out.running = items.length > 0 ? !!items[0].running : null;
  const sessionId = items.length > 0 ? items[0].sessionId : null;
  out.sessionId = String(sessionId);
  window.__b3Stage = 'rpc:' + out.rpc + ':sessions=' + out.sessions;
  // Leg 2: attach the session/journal stream and collect frames until the
  // baseline AND the live turn-2 have both arrived (two assistant/message
  // events, then a quiet window — never timing trust).
  const frames = [];
  out.mux = await new Promise((resolve) => {
    const ws = new WebSocket('ws://' + location.host + '/api/remote.mux');
    const done = (verdict) => { window.__b3Stage = 'ws:' + verdict + ':' + frames.length;
      try { ws.close(); } catch (e) {} resolve(verdict); };
    const t = setTimeout(() => done('timeout'), 20000);
    ws.onopen = () => {
      window.__b3Stage = 'ws-open';
      ws.onmessage = (ev) => {
        const frame = JSON.parse(ev.data);
        if (frame.streamId !== 'b3-probe-journal') return;
        if (frame.type === 'item') frames.push(frame.value);
        if (frame.type === 'error') { clearTimeout(t); done('error:' + (frame.error || {}).code); }
      };
      ws.send(JSON.stringify({type: 'open', streamId: 'b3-probe-journal',
        endpoint: 'session/journal', payload: {args: {address: {sessionId}}}}));
      let lastArrival = Date.now();
      let seen = 0;
      const watch = setInterval(() => {
        const events = frames.filter((f) => f && f.event).map((f) => f.event);
        if (events.length > seen) { lastArrival = Date.now(); seen = events.length; }
        const turnsDone = events.filter((e) => e.type === 'assistant/message').length;
        if (turnsDone >= 2 && Date.now() - lastArrival > 1500) {
          clearInterval(watch); clearTimeout(t); done('frames');
        }
      }, 100);
    };
    ws.onerror = () => { clearTimeout(t); done('ws-error'); };
  });
  const events = frames.filter((f) => f && f.event).map((f) => f.event);
  out.journal = {
    frames: events.length,
    types: events.map((e) => e.type),
    firstSeq: events.length > 0 ? events[0].seq : null,
    lastSeq: events.length > 0 ? events[events.length - 1].seq : null,
  };
  window.__b3Stage = 'journal:' + out.mux + ':' + out.journal.frames;
  // Leg 3: the rendered read — module-system liveness + the TRUE shell
  // state (the upstream DOM, reported as-is).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline
      && (!window.__ModuleLoader__ || window.__ModuleLoader__.mode !== 'live')) {
    await new Promise((r) => setTimeout(r, 50));
  }
  out.moduleMode = window.__ModuleLoader__ ? String(window.__ModuleLoader__.mode) : 'none';
  const boot = document.querySelector('[data-dsh-boot]');
  out.page = {boot: boot !== null,
    rootHasChild: ((document.getElementById('root') || {}).childElementCount || 0) > 0};
  window.__b3Stage = 'parking';
  return JSON.stringify(out);
};
window.__b3Run().then((json) => { window.__b3Out = json; })
  .catch((e) => { window.__b3Out = JSON.stringify({rpc: 'probe-threw:' + String(e)}); });
'probe-started';
`;
  }

  /** Parses one probe result: either the first failed leg's diagnosis, or
   * the ordered verdict events (session.list.real → session.journal.real →
   * module.system.live → page.rendered). */
  static parseVerdict(json: string): ProbeVerdict {
    let probe: ProbeResult;
    try {
      probe = JSON.parse(json) as ProbeResult;
    } catch (e) {
      const fail: ProbeVerdict = { failed: true, events: [],
        reason: 'probe returned no parseable result: ' + json.substring(0, 200) };
      return fail;
    }
    if (probe.shell !== 'shell') {
      const fail: ProbeVerdict = { failed: true, events: [],
        reason: 'the official shell never reached its workspace state: ' +
          (probe.shell ?? 'nil') };
      return fail;
    }
    if (probe.rpc !== 'ok') {
      const fail: ProbeVerdict = { failed: true, events: [],
        reason: 'probe session.list outcome: ' + (probe.rpc ?? 'nil') };
      return fail;
    }
    if (probe.sessions !== 1 || probe.blank !== false) {
      const fail: ProbeVerdict = { failed: true, events: [],
        reason: `probe session.list sessions=${probe.sessions} blank=${probe.blank} ` +
          '(need exactly the configured agent session, non-blank)' };
      return fail;
    }
    const journalProblem = SessionLiveProbe.checkJournal(probe);
    if (journalProblem.length > 0) {
      const fail: ProbeVerdict = { failed: true, events: [], reason: journalProblem };
      return fail;
    }
    const moduleMode = probe.moduleMode ?? 'none';
    if (moduleMode !== 'live') {
      const fail: ProbeVerdict = { failed: true, events: [],
        reason: `the official module system never went live (mode: ${moduleMode})` };
      return fail;
    }
    return { failed: false, reason: '',
      events: SessionLiveProbe.verdictEvents(probe, moduleMode) };
  }

  /** Leg 2 checks: the REAL journal — the first turn's full log in the
   * baseline, then turn 2 streamed live, contiguous seqs. Empty = pass. */
  private static checkJournal(probe: ProbeResult): string {
    const journal = probe.journal;
    if (probe.mux !== 'frames' || journal === undefined) {
      return 'probe journal outcome: ' + (probe.mux ?? 'nil');
    }
    const types = journal.types ?? [];
    if (types.join(',') !== BASELINE_TYPES + ',' + LIVE_TYPES) {
      return `journal frame types mismatch: ${types.length} frames, expected ` +
        `${BASELINE_TYPES.split(',').length + LIVE_TYPES.split(',').length}: ` +
        types.join(',');
    }
    if (journal.firstSeq !== 0 || journal.lastSeq !== types.length - 1) {
      return `journal seq range not contiguous: ${journal.firstSeq}..${journal.lastSeq}`;
    }
    return '';
  }

  /** The ordered verdict events for a passing probe. */
  private static verdictEvents(probe: ProbeResult,
    moduleMode: string): LegEvent[] {
    const types = (probe.journal ?? {}).types ?? [];
    const page = probe.page ?? {};
    const list: LegEvent[] = [];
    const listFields: Record<string, Object> = {
      'sessions': probe.sessions ?? -1,
      'blank': probe.blank ?? true,
      'running': probe.running ?? true,
      'sessionId': probe.sessionId ?? '',
    };
    list.push({ event: 'session.list.real', fields: listFields });
    const journalFields: Record<string, Object> = {
      'frames': types.length,
      'baseline': BASELINE_TYPES.split(',').length,
      'live': LIVE_TYPES.split(',').length,
      'lastType': types.length > 0 ? types[types.length - 1] : '',
    };
    list.push({ event: 'session.journal.real', fields: journalFields });
    const moduleFields: Record<string, Object> = {
      'mode': moduleMode,
      'bootstrap': '@deepseek-ai/dsh-client-modules (vendored)',
    };
    list.push({ event: 'module.system.live', fields: moduleFields });
    const pageFields: Record<string, Object> = {
      'boot': page['boot'] === true,
      'rootHasChild': page['rootHasChild'] === true,
      'moduleMode': moduleMode,
    };
    list.push({ event: 'page.rendered', fields: pageFields });
    return list;
  }
}
