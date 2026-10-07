// dsh:logging-exempt (node-side driver: its stdout IS the product — the
// runner reads the endpoint announce + request telemetry from it)
/**
 * mock-open-design-server.mjs — the loopback stand-in for the Open Design
 * daemon (the nexu-io design service the dsh-open-design system plugin
 * speaks). Node-side, outside quickjs, exactly like the mock LLM driver
 * beside it: the runner starts it, condition-polls stdout for the
 * OD_MOCK_BASE_URL= line, points the CLI scenario's launch env at it, and
 * kills it at exit. Stdout carries the announce plus one JSON line per
 * accepted request (diagnostics — the checker only reads the CLI's stdout).
 *
 * Surface (the subset of the daemon's ten endpoints the scenario drives,
 * same shapes as nano-step/open-design-mcp's vendored od-contracts):
 * projects CRUD + project files, the BYOK proxy stream (SSE start / delta…
 * / end), and artifact save/lint. The proxy stream validates the BYOK wire
 * and streams a canned HTML artifact in deltas — the shape the plugin's SSE
 * consumer parses.
 *
 * usage: node mock-open-design-server.mjs
 */
import { createServer } from 'node:http';

const ARTIFACT_HTML = [
  '<!DOCTYPE html>',
  '<html><head><meta charset="utf-8"><title>Odyssey</title>',
  '<style>body{margin:0;font-family:sans-serif;background:#0b1026;color:#eef}</style>',
  '</head><body><main><h1>Odyssey</h1><p>Aurora card, OD-MOCK-77f3.</p></main>',
  '</body></html>',
].join('\n');

const state = { seq: 0, projects: new Map(), artifacts: new Map() };

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  // content-length framing, NOT node's default chunked: the CLI host's
  // response decoder matches a lowercase "transfer-encoding:" header only,
  // so a chunked JSON body would reach the plugin with its size lines intact.
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
  return payload.length;
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length === 0) return resolve({});
    try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
  });
  req.on('error', reject);
});

const listProjects = (res) => json(res, 200, { projects: [...state.projects.values()] });

const createProject = async (req, res) => {
  const body = await readBody(req);
  const id = `od-proj-${String(++state.seq).padStart(3, '0')}`;
  const project = { id, name: body.name, metadata: body.metadata ?? {}, customInstructions: body.customInstructions };
  state.projects.set(id, project);
  return json(res, 201, { project });
};

const withProject = (res, id, run) => {
  const project = state.projects.get(id);
  if (project === undefined) return json(res, 404, { error: 'no such project' });
  return run(project);
};

const projectRoute = async (req, res, parts) => {
  const method = req.method;
  if (parts.length === 3) {
    return withProject(res, parts[2], async (project) => {
      if (method === 'GET') return json(res, 200, { project, files: project.files ?? [] });
      if (method === 'PATCH') {
        Object.assign(project, await readBody(req));
        return json(res, 200, { project });
      }
      if (method === 'DELETE') {
        state.projects.delete(parts[2]);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'method not allowed' });
    });
  }
  if (method === 'POST' && parts[3] === 'files') {
    return withProject(res, parts[2], async (project) => {
      const body = await readBody(req);
      project.files = project.files ?? [];
      project.files.push({ name: body.name, size: body.content.length, kind: 'html' });
      return json(res, 201, { file: { name: body.name, size: body.content.length } });
    });
  }
  return json(res, 404, { error: `no mock route: ${method}` });
};

const proxyStream = async (req, res, provider) => {
  const wire = await readBody(req);
  const missing = ['baseUrl', 'apiKey', 'model', 'systemPrompt', 'messages', 'maxTokens']
    .filter((key) => wire[key] === undefined || wire[key] === null || wire[key] === '');
  if (missing.length > 0) {
    return json(res, 400, { error: `proxy wire missing: ${missing.join(', ')}` });
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    // lowercase on purpose — see the note in json() above.
    'transfer-encoding': 'chunked',
  });
  const block = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  res.write(block('start', { model: wire.model }));
  for (const delta of ARTIFACT_HTML.match(/[\s\S]{1,64}/g) ?? []) {
    res.write(block('delta', { delta }));
  }
  res.write(block('end', {}));
  res.end();
  console.log(JSON.stringify({
    kind: 'proxy-stream', provider, model: wire.model,
    maxTokens: wire.maxTokens, systemPromptChars: wire.systemPrompt.length,
    messages: wire.messages.length, bytes: ARTIFACT_HTML.length,
  }));
  return ARTIFACT_HTML.length;
};

const artifactRoute = async (req, res, pathname) => {
  const body = await readBody(req);
  if (pathname === '/api/artifacts/save') {
    if (typeof body.identifier !== 'string' || typeof body.html !== 'string') {
      return json(res, 400, { error: 'save needs identifier + html' });
    }
    state.artifacts.set(body.identifier, { title: body.title, html: body.html });
    return json(res, 201, { url: `http://127.0.0.1/artifact/${body.identifier}`, path: `artifacts/${body.identifier}.html` });
  }
  if (typeof body.html !== 'string') return json(res, 400, { error: 'lint needs html' });
  return json(res, 200, {
    findings: [{ severity: 'info', message: 'od-mock: artifact looks self-contained', line: 1 }],
    agentMessage: 'no blocking findings',
  });
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter((p) => p.length > 0);
  let bytes;
  try {
    if (req.method === 'GET' && url.pathname === '/api/projects') bytes = listProjects(res);
    else if (req.method === 'POST' && url.pathname === '/api/projects') bytes = await createProject(req, res);
    else if (parts[0] === 'api' && parts[1] === 'projects') bytes = await projectRoute(req, res, parts);
    else if (req.method === 'POST' && parts[1] === 'proxy') bytes = await proxyStream(req, res, parts[2]);
    else if (req.method === 'POST' && parts[1] === 'artifacts') bytes = await artifactRoute(req, res, url.pathname);
    else bytes = json(res, 404, { error: `no mock route: ${req.method} ${url.pathname}` });
    if (parts[1] !== 'proxy') { // the proxy stream logs its own richer line
      console.log(JSON.stringify({ kind: 'request', method: req.method, path: url.pathname, bytes }));
    }
  } catch (error) {
    json(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`OD_MOCK_BASE_URL=http://127.0.0.1:${port}`);
});
