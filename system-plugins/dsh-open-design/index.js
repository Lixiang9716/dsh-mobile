// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * dsh-open-design — the Open Design client for hosts that cannot run its
 * MCP bridge.
 *
 * Open Design (the nexu-io design daemon) is a design-generation service a
 * coding agent drives over plain HTTP/JSON: projects, artifact persistence,
 * artifact linting, and a BYOK streaming proxy that turns a design request
 * into an HTML artifact. The ecosystem's official bridge is an MCP stdio
 * server (`open-design-mcp`, Apache-2.0, the API surface this file ports) —
 * a child process, which this runtime does not have. The daemon contract
 * needs nothing a subprocess provides, so this plugin speaks the SAME ten
 * endpoints directly over the contract's `httpFetch` primitive: projects
 * CRUD, project files, `POST /api/proxy/<provider>/stream` (SSE), and
 * artifact save/lint.
 *
 * The model's surface is three tools: open_design_projects (verbs),
 * open_design_generate (BYOK stream → HTML artifact), open_design_artifact
 * (save / lint). NOT ported, and said out loud rather than faked: the
 * design-system trio and compose_brief — their prompt composition depends on
 * Open Design's own contracts package; the generate leg carries a compact
 * artifact contract instead, and closing that gap means vendoring the prompt
 * stack, not inventing one.
 *
 * Configuration (the ish executor's two-tier shape; a host that resolves no
 * daemon URL offers no tools):
 *   __dshOpenDesign {daemonUrl, token?, byok?}   the host's declaration, or
 *   DSH_OPEN_DESIGN_URL / _TOKEN / _BYOK_BASE_URL / _BYOK_API_KEY /
 *   _BYOK_MODEL / _BYOK_PROVIDER                 the launch environment
 * BYOK is deliberately SEPARATE from the session's own LLM route: generate
 * runs on the daemon's provider proxy, and the session's credentials are
 * never shared with it implicitly.
 */
import { createLogger } from 'logger.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { httpFetch } from 'gateway.js';

const log = createLogger('dsh.openDesign');

export const manifest = {
  schemaVersion: 1,
  id: 'dsh-open-design',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['httpFetch'], optional: [] },
  hooks: { activate: 'activate' },
};

const PROJECT_KINDS = ['prototype', 'deck', 'template', 'other', 'image', 'video', 'audio'];

/** UTF-8 over the gateway's byte bodies: the mirror of llm-transport's
 * utf8Encode, kept local because the plugin imports the gateway alone. */
const utf8Encode = (text) => {
  const bytes = [];
  for (const point of text) {
    const value = point.codePointAt(0);
    if (value < 0x80) bytes.push(value);
    else if (value < 0x800) bytes.push(0xc0 | (value >> 6), 0x80 | (value & 63));
    else if (value < 0x10000) bytes.push(0xe0 | (value >> 12), 0x80 | ((value >> 6) & 63), 0x80 | (value & 63));
    else bytes.push(0xf0 | (value >> 18), 0x80 | ((value >> 12) & 63), 0x80 | ((value >> 6) & 63), 0x80 | (value & 63));
  }
  return Uint8Array.from(bytes);
};

const utf8Decode = (bytes) => {
  const codes = [];
  for (let at = 0; at < bytes.length;) {
    const b0 = bytes[at];
    let point;
    let width;
    if (b0 < 0x80) { point = b0; width = 1; }
    else if (b0 < 0xe0) { point = b0 & 0x1f; width = 2; }
    else if (b0 < 0xf0) { point = b0 & 0x0f; width = 3; }
    else { point = b0 & 0x07; width = 4; }
    for (let i = 1; i < width && at + i < bytes.length; i += 1) {
      point = (point << 6) | (bytes[at + i] & 0x3f);
    }
    codes.push(point);
    at += width;
  }
  return String.fromCodePoint(...codes);
};

/** The resolved configuration: {daemonUrl, token?, byok?}. `byok` is lazily
 * demanded by the generate leg only — the project/artifact legs never need
 * a provider key. Read from the host declaration first, the launch
 * environment second; a host that declares neither offers no tools. */
const resolveConfig = () => {
  const declared = globalThis.__dshOpenDesign;
  const env = globalThis.__dshProfileLaunch ?? {};
  const pick = (a, b) => {
    const first = typeof a === 'string' && a.length > 0 ? a : undefined;
    return first ?? (typeof b === 'string' && b.length > 0 ? b : undefined);
  };
  const daemonUrl = pick(declared?.daemonUrl, env.DSH_OPEN_DESIGN_URL);
  if (daemonUrl === undefined) return undefined;
  const byok = declared?.byok ?? {
    baseUrl: env.DSH_OPEN_DESIGN_BYOK_BASE_URL,
    apiKey: env.DSH_OPEN_DESIGN_BYOK_API_KEY,
    model: env.DSH_OPEN_DESIGN_BYOK_MODEL,
    provider: env.DSH_OPEN_DESIGN_BYOK_PROVIDER,
  };
  const base = String(daemonUrl).replace(/\/+$/, '');
  log.debug('daemon configuration resolved', { base, auth: pick(declared?.token, env.DSH_OPEN_DESIGN_TOKEN) !== undefined ? 'bearer' : 'none' });
  return { daemonUrl: base, token: pick(declared?.token, env.DSH_OPEN_DESIGN_TOKEN), byok };
};

/** Consume one response body to a string (the gateway yields Uint8Array
 * chunks over an async iterable). */
const readBody = async (body) => {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return utf8Decode(Uint8Array.from(chunks.flatMap((c) => Array.from(c))));
};

/** One daemon request: JSON in, parsed JSON out. Non-2xx is a NAMED result
 * the caller turns into tool output — the model asked what the daemon said,
 * and the status + body snippet are the answer (never a bare throw). */
const odRequest = async (config, method, path, payload) => {
  log.debug('daemon request', { method, path });
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (config.token !== undefined) headers.authorization = `Bearer ${config.token}`;
  const body = payload === undefined ? undefined : utf8Encode(JSON.stringify(payload));
  const response = await httpFetch(`${config.daemonUrl}${path}`, { method, headers, body });
  const raw = await readBody(response.body);
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, status: response.status, error: raw.slice(0, 500) || `(no body)` };
  }
  try {
    return { ok: true, status: response.status, data: raw.length > 0 ? JSON.parse(raw) : null };
  } catch {
    return { ok: false, status: response.status, error: `non-JSON daemon response: ${raw.slice(0, 200)}` };
  }
};

/** One SSE block (split on \n\n) folded into the stream state — the W3C
 * shape the daemon's contracts freeze (event: + data: lines). A malformed
 * delta is dropped, the stream's own convention. */
const foldBlock = (state, block) => {
  let event = null;
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':') || line.length === 0) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  const data = dataLines.join('\n');
  if (event === 'delta') {
    try { state.artifact += JSON.parse(data).delta ?? ''; } catch { /* dropped */ }
  } else if (event === 'start') {
    try { state.model = JSON.parse(data).model; } catch { /* start may carry no body */ }
  } else if (event === 'end' || event === 'error') {
    if (event === 'error') {
      try { state.failure = JSON.parse(data).message ?? 'unknown daemon error'; } catch { state.failure = 'unknown daemon error'; }
    }
    state.done = true;
  }
};

/** Consume the BYOK proxy's SSE stream: `start` (carries the model),
 * `delta` (artifact text), `end`, `error`. */
const consumeDesignStream = async (config, provider, wire) => {
  log.debug('proxy stream open', { provider, maxTokens: wire.maxTokens });
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (config.token !== undefined) headers.authorization = `Bearer ${config.token}`;
  const path = `/api/proxy/${encodeURIComponent(provider)}/stream`;
  const response = await httpFetch(`${config.daemonUrl}${path}`, {
    method: 'POST', headers, body: utf8Encode(JSON.stringify(wire)),
  });
  if (response.status < 200 || response.status >= 300) {
    const raw = await readBody(response.body);
    return { ok: false, status: response.status, error: raw.slice(0, 500) || `(no body)` };
  }
  const state = { artifact: '', model: undefined, failure: undefined, done: false };
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += utf8Decode(chunk);
    let at = buffer.indexOf('\n\n');
    while (at >= 0) {
      foldBlock(state, buffer.slice(0, at));
      buffer = buffer.slice(at + 2);
      at = buffer.indexOf('\n\n');
    }
    if (state.done) break;
  }
  if (state.failure !== undefined) return { ok: false, status: response.status, error: state.failure };
  if (!state.done && state.artifact.length === 0) {
    return { ok: false, status: response.status, error: 'the proxy stream ended without an end event and produced no artifact' };
  }
  return {
    ok: true, status: response.status,
    artifact: state.artifact, model: state.model, chars: state.artifact.length,
  };
};

/** The generate leg's system prompt: a compact artifact contract. The FULL
 * Open Design designer charter (official-system + discovery + deck
 * framework) is deliberately not vendored — see the header. */
const DESIGN_SYSTEM_PROMPT = 'You are a senior product designer producing a single self-contained HTML artifact. '
  + 'Output ONLY one complete HTML5 document (<!DOCTYPE html> ... </html>), no markdown fences, no commentary. '
  + 'All CSS lives in one <style> block in the head; all JS in one <script> block before </body>; '
  + 'no external requests (fonts, CDNs, images) — the artifact renders offline. '
  + 'Design for a phone-width viewport, responsive up to desktop: readable type, real spacing scale, '
  + 'coherent palette, purposeful motion. Ship working interactions, not placeholders.';

/** The projects tool's verb handlers — one narrow function per verb, the
 * daemon's project + file endpoints one to one. A verb returns a plain
 * outcome object the tool layer stringifies. */
const projectVerbs = {
  async list(config) {
    const res = await odRequest(config, 'GET', '/api/projects');
    if (!res.ok) return res;
    const projects = (res.data?.projects ?? []).map((p) => ({
      id: p.id, name: p.name, kind: p.metadata?.kind ?? p.kind,
      updatedAt: p.updatedAt ?? p.mtime,
    }));
    return { ok: true, projects, count: projects.length };
  },
  async get(config, args) {
    if (typeof args.id !== 'string' || args.id.length === 0) {
      return { ok: false, error: 'verb "get" requires the project id' };
    }
    const res = await odRequest(config, 'GET', `/api/projects/${encodeURIComponent(args.id)}`);
    return res.ok ? { ok: true, project: res.data?.project, files: res.data?.files } : res;
  },
  async create(config, args) {
    if (typeof args.name !== 'string' || args.name.trim().length === 0) {
      return { ok: false, error: 'verb "create" requires a project name' };
    }
    const body = { name: args.name.trim(), metadata: { kind: args.kind ?? 'prototype' } };
    if (typeof args.customInstructions === 'string' && args.customInstructions.length > 0) {
      body.customInstructions = args.customInstructions;
    }
    const res = await odRequest(config, 'POST', '/api/projects', body);
    return res.ok ? { ok: true, project: res.data?.project } : res;
  },
  async update(config, args) {
    if (typeof args.id !== 'string' || args.id.length === 0) {
      return { ok: false, error: 'verb "update" requires the project id' };
    }
    const body = {};
    if (typeof args.name === 'string' && args.name.trim().length > 0) body.name = args.name.trim();
    if (typeof args.customInstructions === 'string') body.customInstructions = args.customInstructions;
    if (Object.keys(body).length === 0) {
      return { ok: false, error: 'verb "update" needs at least one of: name, customInstructions' };
    }
    const res = await odRequest(config, 'PATCH', `/api/projects/${encodeURIComponent(args.id)}`, body);
    return res.ok ? { ok: true, project: res.data?.project } : res;
  },
  async delete(config, args) {
    if (typeof args.id !== 'string' || args.id.length === 0) {
      return { ok: false, error: 'verb "delete" requires the project id' };
    }
    const res = await odRequest(config, 'DELETE', `/api/projects/${encodeURIComponent(args.id)}`);
    return res.ok ? { ok: true, deleted: args.id } : res;
  },
  async save_file(config, args) {
    if (typeof args.id !== 'string' || args.id.length === 0) {
      return { ok: false, error: 'verb "save_file" requires the project id' };
    }
    if (typeof args.fileName !== 'string' || args.fileName.length === 0
        || typeof args.content !== 'string' || args.content.length === 0) {
      return { ok: false, error: 'verb "save_file" requires fileName and content' };
    }
    const res = await odRequest(config, 'POST', `/api/projects/${encodeURIComponent(args.id)}/files`, {
      name: args.fileName, content: args.content,
    });
    return res.ok ? { ok: true, file: res.data?.file ?? res.data } : res;
  },
};

/** Shared tool-result shape: the plugin stringifies one outcome object per
 * call, and the render surface shows it verbatim. */
const toolOutput = () => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      result: { type: 'string', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.result }],
});

const wrap = async (name, run) => {
  log.debug('tool invoked', { name });
  const outcome = await run();
  return { ok: outcome.ok === true, result: JSON.stringify(outcome) };
};

const requireText = (args, keys) => {
  const missing = keys.filter((key) => typeof args[key] !== 'string' || args[key].length === 0);
  return missing.length === 0 ? undefined : `missing: ${missing.join(', ')}`;
};

const projectsTool = (config) => defineTool({
  name: 'open_design_projects',
  description: 'Drive the Open Design daemon\'s projects: list, get, create, '
    + 'update, delete, or save a file into a project. Open Design stores and '
    + 'renders design artifacts (HTML prototypes, decks) and lints them. '
    + 'Typical flow: create a project → generate a design (open_design_generate) '
    + '→ save the artifact (open_design_artifact save) or save files into the '
    + 'project. Requires a configured daemon; without one the error names it.',
  parameters: {
    verb: {
      type: 'string', required: true,
      description: 'One of: list, get, create, update, delete, save_file.',
    },
    id: { type: 'string', description: 'The project id (get/update/delete/save_file).' },
    name: { type: 'string', description: 'Project name (create; rename via update).' },
    kind: {
      type: 'string',
      description: 'Project kind for create: one of '
        + PROJECT_KINDS.join(', ') + ' (default prototype).',
    },
    customInstructions: {
      type: 'string',
      description: 'Standing instructions stored on the project (create/update).',
    },
    fileName: { type: 'string', description: 'File name for save_file (e.g. index.html).' },
    content: { type: 'string', description: 'File content for save_file.' },
  },
  output: toolOutput(),
  async execute(args) {
    return wrap(args.verb, async () => {
      const handler = projectVerbs[args.verb];
      if (handler === undefined) {
        return { ok: false, error: `unknown verb: ${String(args.verb)} — use list|get|create|update|delete|save_file` };
      }
      return handler(config, args);
    });
  },
});

const generateTool = (config) => defineTool({
  name: 'open_design_generate',
  description: 'Generate a design artifact through the Open Design daemon: '
    + 'one design request in, one self-contained HTML artifact out. Streams '
    + 'through the daemon\'s provider proxy (BYOK — the daemon\'s configured '
    + 'provider key, NOT this session\'s own route). Pass projectId when the '
    + 'request continues an existing project so its stored instructions apply. '
    + 'After generating, persist with open_design_artifact save or present the '
    + 'HTML directly.',
  parameters: {
    prompt: {
      type: 'string', required: true,
      description: 'The design request, as the user asked for it.',
    },
    projectId: {
      type: 'string',
      description: 'Existing project to generate into (its stored '
        + 'customInstructions merge into the request).',
    },
    kind: {
      type: 'string',
      description: 'Artifact kind when no projectId is given: '
        + PROJECT_KINDS.join(', ') + ' (default prototype).',
    },
    maxTokens: {
      type: 'integer',
      description: 'Completion cap forwarded to the provider (default 64000).',
    },
  },
  output: toolOutput(),
  async execute(args) {
    return wrap('generate', async () => runGenerate(config, args));
  },
});

/** The generate leg: BYOK demanded lazily, stored project instructions
 * merged, the SSE proxy stream reassembled. */
const runGenerate = async (config, args) => {
  const byok = config.byok ?? {};
  const missing = requireText(byok, ['baseUrl', 'apiKey', 'model']);
  if (missing !== undefined) {
    log.debug('generate refused: BYOK unconfigured');
    return { ok: false, error: 'Open Design generate needs a BYOK provider: set '
      + 'DSH_OPEN_DESIGN_BYOK_BASE_URL, DSH_OPEN_DESIGN_BYOK_API_KEY and '
      + 'DSH_OPEN_DESIGN_BYOK_MODEL (the daemon proxies to that provider; the '
      + 'session\'s own credentials are not shared with it).' };
  }
  let storedInstructions;
  if (typeof args.projectId === 'string' && args.projectId.length > 0) {
    const detail = await odRequest(config, 'GET', `/api/projects/${encodeURIComponent(args.projectId)}`);
    if (!detail.ok) return detail;
    storedInstructions = detail.data?.project?.customInstructions;
  }
  const userContent = typeof storedInstructions === 'string' && storedInstructions.length > 0
    ? `${storedInstructions}\n\n---\n\n${args.prompt}`
    : String(args.prompt ?? '');
  const provider = typeof byok.provider === 'string' && byok.provider.length > 0
    ? byok.provider : 'openai';
  log.info('design generation starting', {
    provider, model: byok.model, projectId: args.projectId ?? null,
  });
  const outcome = await consumeDesignStream(config, provider, {
    baseUrl: byok.baseUrl,
    apiKey: byok.apiKey,
    model: byok.model,
    systemPrompt: DESIGN_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    maxTokens: typeof args.maxTokens === 'number' && Number.isInteger(args.maxTokens)
      && args.maxTokens > 0 ? args.maxTokens : 64000,
  });
  if (!outcome.ok) log.warn('design generation failed', { status: outcome.status });
  else log.info('design generation complete', { chars: outcome.chars });
  return outcome;
};

const artifactTool = (config) => defineTool({
  name: 'open_design_artifact',
  description: 'Persist or lint an Open Design artifact. save: store the HTML '
    + 'with the daemon and get back its shareable URL/path (identifier + title '
    + '+ html). lint: run the daemon\'s artifact linter over HTML and get '
    + 'findings (severity, message) — run it after generating or editing an '
    + 'artifact, before presenting it.',
  parameters: {
    verb: { type: 'string', required: true, description: 'One of: save, lint.' },
    identifier: {
      type: 'string',
      description: 'Stable artifact identifier for save (e.g. the project id '
        + 'or a slug you keep stable across revisions).',
    },
    title: { type: 'string', description: 'Human title for save.' },
    html: { type: 'string', description: 'The artifact HTML (save and lint).' },
  },
  output: toolOutput(),
  async execute(args) {
    return wrap(args.verb, async () => runArtifactVerb(config, args));
  },
});

/** The artifact verbs: save (identifier+title+html → url/path) and lint
 * (html → findings). */
const runArtifactVerb = async (config, args) => {
  if (args.verb === 'save') {
    const missing = requireText(args, ['identifier', 'title', 'html']);
    if (missing !== undefined) return { ok: false, error: `verb "save" ${missing}` };
    const outcome = await odRequest(config, 'POST', '/api/artifacts/save', {
      identifier: args.identifier, title: args.title, html: args.html,
    });
    return outcome.ok ? { ok: true, ...outcome.data } : outcome;
  }
  if (args.verb === 'lint') {
    if (typeof args.html !== 'string' || args.html.length === 0) {
      return { ok: false, error: 'verb "lint" requires html' };
    }
    const outcome = await odRequest(config, 'POST', '/api/artifacts/lint', { html: args.html });
    return outcome.ok ? { ok: true, ...outcome.data } : outcome;
  }
  return { ok: false, error: `unknown verb: ${String(args.verb)} — use save|lint` };
};

export function activate() {
  const config = resolveConfig();
  if (config === undefined) {
    log.info('no Open Design daemon configured; the open_design tools are not offered');
    return;
  }
  log.info('Open Design daemon configured', { base: config.daemonUrl });
}

/** The spine's mount shape (boot.js): the tool registration lives in `apply`
 * because it is conditional on the resolved daemon configuration — the same
 * mount-then-decline split the ish executor uses for its guest root. */
export const name = 'dsh-open-design';
export const inject = ['tools'];

export const apply = (ctx) => {
  const config = resolveConfig();
  if (config === undefined) {
    log.info('no Open Design daemon configured; the open_design tools are not offered');
    return;
  }
  ctx.tools.register(projectsTool(config));
  ctx.tools.register(generateTool(config));
  ctx.tools.register(artifactTool(config));
};
