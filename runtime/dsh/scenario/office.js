/**
 * Office scenario `office` — the dsh-office system plugin (the ported
 * dsh-office-tools surface) driving Word, Excel, and PowerPoint documents
 * over the gateway fs primitives.
 *
 * Flow: the mobile profile boot mounts the plugin beside the spine (the
 * launch env carries the mock LLM route the boot requires; no daemon is
 * needed — the office tools gate on nothing). The scenario drives the REAL
 * ToolRuntime dispatch of all eight tools:
 *
 *   1. offered: the spine serves all eight office_* tools;
 *   2. word: create → read back (markdown shape) → append → verify tail;
 *   3. excel: create (grid + formula) → read back → cell update → verify;
 *   4. ppt: create (title slide + bullets + notes) → read back layout;
 *   5. fixtures: REAL-library .docx/.xlsx/.pptx bytes (python-docx /
 *      openpyxl / python-pptx, committed as base64 in office-fixtures.js)
 *      written into the workspace and read — the view legs against files
 *      this plugin did not write;
 *   6. negative: word_create refuses an existing path without overwrite.
 *
 * Every expected event emits exactly one structured log entry, in the order
 * declared by test/e2e/scenarios/office.json; artifacts land under
 * runtime/dsh/artifacts/macos-cli-office/.
 */
import { createLogger } from 'logger.js';
import { fsScope, fsWrite } from 'gateway.js';
import { bootUpstream } from 'upstream/boot.js';
import { OFFICE_FIXTURES } from './office-fixtures.js';

const SCENARIO = 'office';
const AGENT_ID = 'main';
const SESSION_ID = 's-office-0001';

const log = createLogger('m2.spike');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  const error = reason instanceof Error ? reason : null;
  const message = error ? error.message : String(reason);
  log.debug('scenario failed', { reason: message });
  emit('scenario.failed', { reason: message });
  globalThis.__dshComplete(false, message);
};
const demand = (cond, reason) => {
  if (cond) return;
  log.debug('demand failed', { reason });
  fail(reason);
  throw new Error(reason);
};

const launchEnv = () => {
  log.debug('launch env phase begin', {});
  const raw = globalThis.__dshLaunchEnv?.();
  demand(typeof raw === 'string', 'launch env snapshot missing (CLI must pass --env)');
  return JSON.parse(raw);
};

/** One tool call through the REAL ToolRuntime dispatch, returning the
 * plugin's structured outcome ({ok, result}). */
const call = async (ctx, name, args) => {
  log.debug('tool dispatch', { name });
  const outcome = await ctx.tools.execute({
    name,
    arguments: args,
    callId: `${SCENARIO}.${name}`,
    signal: new AbortController().signal,
  });
  demand(outcome?.isError !== true, `${name} dispatch failed: ${JSON.stringify(outcome?.error ?? outcome).slice(0, 300)}`);
  const value = outcome.value;
  demand(value !== undefined && value !== null && typeof value === 'object',
    `${name} returned no structured value: ${JSON.stringify(value).slice(0, 200)}`);
  return value;
};

const callRaw = async (ctx, name, args) => {
  log.debug('raw dispatch (outcome unshaped)', { name });
  const outcome = await ctx.tools.execute({
    name,
    arguments: args,
    callId: `${SCENARIO}.${name}.raw`,
    signal: new AbortController().signal,
  });
  return outcome;
};

const bootPhase = async (env) => {
  log.debug('boot phase begin', {});
  const resolved = await fsScope.resolve('scope://app/');
  const root = resolved?.path;
  demand(typeof root === 'string' && root.startsWith('/'), `profile container not resolved: ${JSON.stringify(root)}`);
  const { ctx } = await bootUpstream({
    scenario: SCENARIO,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    cwd: root,
    onEvent: emit,
    container: {
      cwd: root,
      scopeRoot: root,
      tmpdir: `${root}/tmp`,
      home: `${root}/home`,
      env,
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      baseURL: env.DSH_MOCK_LLM_URL,
      apiKey: env.DSH_MOCK_LLM_KEY,
      provider: 'mock',
      model: 'mock-1',
    },
  });
  log.debug('boot phase done', { root });
  return ctx;
};

const offeredPhase = (ctx) => {
  log.debug('offered phase begin', {});
  const visible = ctx.tools?.view?.(undefined)?.visible;
  demand(visible instanceof Map, 'the tool layer exposed no visibility view');
  const names = ['word_create', 'word_read', 'word_update', 'excel_create', 'excel_read', 'excel_update', 'ppt_create', 'ppt_read'];
  for (const name of names) {
    demand(visible.has(name), `the office tool ${name} is not offered`);
  }
  emit('office/offered', { tools: names.length });
};

const wordPhase = async (ctx) => {
  log.debug('word phase begin', {});
  const created = await call(ctx, 'word_create', {
    path: 'docs/demo.docx',
    title: 'Quarterly Notes',
    paragraphs: ['The quarter closed on plan.', 'Second paragraph for the record.'],
    bullets: ['Revenue held', 'Churn fell', 'Hiring paused'],
    table: {
      headers: ['Metric', 'Q2', 'Q3'],
      rows: [['NRR', '112%', '118%'], ['Headcount', '41', '43']],
    },
  });
  demand(created.path === 'docs/demo.docx', `word_create failed: ${JSON.stringify(created).slice(0, 200)}`);
  demand(created.paragraphCount === 3 && created.bulletCount === 3 && created.tableRows === 2,
    `word_create counts drifted: ${JSON.stringify(created)}`);
  emit('office.word/created', { path: created.path, paragraphs: created.paragraphCount, bullets: created.bulletCount, tableRows: created.tableRows });

  const markdown = await call(ctx, 'word_read', { path: 'docs/demo.docx', format: 'markdown', max_chars: 4000 });
  demand(markdown.text.includes('# Quarterly Notes'),
    `the markdown read lost the title: ${JSON.stringify(markdown).slice(0, 200)}`);
  demand(markdown.text.includes('- Revenue held') && markdown.text.includes('| NRR | 112% | 118% |'),
    `the markdown read lost the bullets/table: ${markdown.text.slice(0, 200)}`);
  emit('office.word/readMarkdown', { headings: 1, bullets: 3, tableRows: 2 });

  const appended = await call(ctx, 'word_update', {
    path: 'docs/demo.docx',
    paragraphs: ['Appended in a second pass.'],
  });
  demand(appended.appendedParagraphs === 1, `word_update failed: ${JSON.stringify(appended).slice(0, 200)}`);
  const tail = await call(ctx, 'word_read', { path: 'docs/demo.docx', max_chars: 4000 });
  demand(tail.text.includes('Appended in a second pass.'),
    `the appended paragraph is missing: ${tail.text.slice(-160)}`);
  emit('office.word/appended', { paragraphs: appended.appendedParagraphs, verified: true });
};

const excelPhase = async (ctx) => {
  log.debug('excel phase begin', {});
  const created = await call(ctx, 'excel_create', {
    path: 'sheets/demo.xlsx',
    sheets: [{
      name: 'Q3',
      rows: [
        ['Metric', 'Value', 'Ok'],
        ['NRR', 1.18, true],
        ['Churn', 0.04, false],
        ['Model', '=NRR+1', null],
      ],
    }],
  });
  demand(created.sheets.length === 1, `excel_create failed: ${JSON.stringify(created).slice(0, 200)}`);
  demand(created.sheets[0].rowCount === 4 && created.sheets[0].colCount === 3,
    `excel_create shape drifted: ${JSON.stringify(created.sheets)}`);
  emit('office.excel/created', { path: created.path, sheets: created.sheets.length, rows: 4 });

  const read = await call(ctx, 'excel_read', { path: 'sheets/demo.xlsx', sheet: 'Q3' });
  const rows = read.sheets[0]?.rows ?? [];
  demand(read.sheets.length === 1 && rows.length === 4, `excel_read lost rows: ${JSON.stringify(read).slice(0, 200)}`);
  demand(rows[1][1] === '1.18' && rows[2][2] === 'FALSE' && rows[3][1] === '=NRR+1',
    `the round-trip values drifted: ${JSON.stringify(rows[1])} / ${JSON.stringify(rows[2])} / ${JSON.stringify(rows[3])}`);
  emit('office.excel/readBack', { rows: rows.length, cells: 12, truncated: false });

  const updated = await call(ctx, 'excel_update', {
    path: 'sheets/demo.xlsx',
    cell_updates: [{ sheet: 'Q3', cell: 'B2', value: 1.24 }],
  });
  demand(updated.cellUpdates.length === 1, `excel_update failed: ${JSON.stringify(updated).slice(0, 200)}`);
  const reread = await call(ctx, 'excel_read', { path: 'sheets/demo.xlsx', sheet: 'Q3' });
  demand(reread.sheets[0].rows[1][1] === '1.24', `the cell write did not land: ${JSON.stringify(reread.sheets[0].rows[1])}`);
  emit('office.excel/updated', { cellWrites: updated.cellUpdates.length, value: '1.24' });
};

const pptPhase = async (ctx) => {
  log.debug('ppt phase begin', {});
  const created = await call(ctx, 'ppt_create', {
    path: 'decks/demo.pptx',
    title: 'Q3 Review',
    slides: [{
      title: 'The Numbers',
      paragraphs: ['Revenue held against plan.'],
      bullets: ['NRR 118%', 'Churn 4%'],
      notes: 'Walk the room through the funnel first.',
    }],
  });
  demand(created.slideCount === 2, `ppt_create failed: ${JSON.stringify(created).slice(0, 240)}`);
  demand(created.slideWidthInches === 13.33 && created.slideHeightInches === 7.5,
    `the canvas drifted: ${JSON.stringify(created.slideWidthInches)}x${JSON.stringify(created.slideHeightInches)}`);
  emit('office.ppt/created', { path: created.path, slides: created.slideCount, canvas: '13.33x7.5' });

  const read = await call(ctx, 'ppt_read', { path: 'decks/demo.pptx', max_chars: 6000 });
  demand(read.slideCount === 2, `ppt_read lost slides: ${JSON.stringify(read).slice(0, 200)}`);
  const numbers = read.slides[1];
  demand((numbers?.paragraphs ?? []).some((p) => p.includes('Revenue held')), 'ppt_read lost the body paragraph');
  demand((numbers?.bullets ?? (numbers?.elements ?? []).filter((e) => e.type === 'bullets')) !== undefined
    && JSON.stringify(numbers).includes('NRR 118%'), 'ppt_read lost the bullets');
  demand(JSON.stringify(read).includes('Walk the room through the funnel first.'), 'ppt_read lost the notes');
  emit('office.ppt/readBack', { slides: read.slideCount, elements: read.slides.reduce((sum, slide) => sum + (slide.elements?.length ?? 0), 0) });
};

/** The view legs against REAL-library files: the committed fixtures are
 * python-docx / openpyxl / python-pptx output, embedded as base64 so the
 * scenario stages them into the profile container itself. */
const fixturePhase = async (ctx) => {
  log.debug('fixture phase begin', {});
  const seed = async (name, base64) => {
    const binary = globalThis.Buffer.from(base64, 'base64');
    await fsWrite('app', name, new Uint8Array(binary), { create: true });
  };
  await seed('fixtures/sample.docx', OFFICE_FIXTURES.docx);
  await seed('fixtures/sample.xlsx', OFFICE_FIXTURES.xlsx);
  await seed('fixtures/sample.pptx', OFFICE_FIXTURES.pptx);

  const docx = await call(ctx, 'word_read', { path: 'fixtures/sample.docx', format: 'markdown', max_chars: 4000 });
  demand(docx.totalChars > 40, `the python-docx fixture read came back empty: ${JSON.stringify(docx).slice(0, 200)}`);
  demand(docx.text.includes('#'), `the python-docx fixture lost its heading: ${docx.text.slice(0, 160)}`);
  emit('office.fixture/docx', { chars: docx.totalChars, markdown: true });

  const xlsx = await call(ctx, 'excel_read', { path: 'fixtures/sample.xlsx', max_rows: 100 });
  const sheet = xlsx.sheets[0];
  demand(xlsx.sheets.length === 1 && sheet.rows.length >= 2, `the openpyxl fixture read lost rows: ${JSON.stringify(xlsx).slice(0, 240)}`);
  demand(JSON.stringify(sheet.rows[0]) === JSON.stringify(['Region', 'Units']), `the openpyxl fixture header drifted: ${JSON.stringify(sheet.rows[0])}`);
  demand(sheet.rows[1][0] === 'North' && sheet.rows[1][1] === '120', `the openpyxl fixture values drifted: ${JSON.stringify(sheet.rows[1])}`);
  emit('office.fixture/xlsx', { rows: sheet.rows.length, sheet: sheet.name });

  const pptx = await call(ctx, 'ppt_read', { path: 'fixtures/sample.pptx', max_chars: 6000 });
  demand(pptx.slideCount >= 2, `the python-pptx fixture read lost slides: ${JSON.stringify(pptx).slice(0, 200)}`);
  demand(JSON.stringify(pptx).includes('Fixture Deck'), 'the python-pptx fixture lost its title');
  emit('office.fixture/pptx', { slides: pptx.slideCount, width: Math.round(pptx.slideWidthInches * 100) / 100 });
};

const negativePhase = async (ctx) => {
  log.debug('negative phase begin', {});
  const refused = await callRaw(ctx, 'word_create', {
    path: 'docs/demo.docx',
    title: 'Should Not Land',
  });
  demand(refused?.isError === true, 'word_create did not refuse an existing path without overwrite');
  demand(JSON.stringify(refused?.error ?? refused).includes('overwrite'), `the refusal does not name overwrite: ${JSON.stringify(refused?.error ?? refused).slice(0, 200)}`);
  emit('office.negative/refused', { named: 'overwrite' });
};

const main = async () => {
  log.debug('main begin', {});
  const env = launchEnv();
  demand(typeof env.DSH_MOCK_LLM_URL === 'string' && env.DSH_MOCK_LLM_URL.startsWith('http://127.0.0.1:'),
    `the mock LLM URL is not the loopback mock: ${JSON.stringify(env.DSH_MOCK_LLM_URL)}`);
  const ctx = await bootPhase(env);
  emit('session/created', { sessionId: SESSION_ID });
  emit('agent/created', { id: AGENT_ID, sessionId: SESSION_ID });

  offeredPhase(ctx);
  await wordPhase(ctx);
  await excelPhase(ctx);
  await pptPhase(ctx);
  await fixturePhase(ctx);
  await negativePhase(ctx);

  emit('upstream/completed', {
    status: 'pass',
    upstream: '0.1.6-alpha.2',
    office: 'system-plugins/dsh-office (dsh-office-tools surface over gateway fs)',
  });
  globalThis.__dshComplete(true, 'pass');
};

main().catch(fail);
