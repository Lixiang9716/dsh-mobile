
import { createLogger } from 'logger.js';
import { fsScope } from 'gateway.js';
import 'upstream/shims/npm-bridges.js';
const log = createLogger('v7');
try {
  const root = await fsScope.resolve();
  globalThis.__dshProfileScopeRoot = root.path;
  globalThis.__dshProfileCwd = root.path;
  const { registerWordTools } = await import('system-plugins/dsh-office/word.js');
  const { registerExcelTools } = await import('system-plugins/dsh-office/excel.js');
  const { registerPptCreate } = await import('system-plugins/dsh-office/ppt-create.js');
  const [wc] = registerWordTools();
  const [ec] = registerExcelTools();
  const pc = registerPptCreate();
  await wc.execute({ path: 'val.docx', title: 'D', paragraphs: ['x'], bullets: ['b'], table: { headers: ['H'], rows: [['r']] } });
  const ex = await ec.execute({ path: 'val.xlsx', sheets: [{ name: 'S1', rows: [['Name', 'N'], ['x', 7]] }] });
  await pc.execute({ path: 'val.pptx', title: 'Deck', slides: [{ title: 'S', bullets: ['p'], notes: 'n' }] });
  log.info('v7', { step: 'all-done' });
  globalThis.__dshComplete(true, 'pass');
} catch (e) {
  log.info('v7', { caught: `${typeof e}`, str: `${e}`.slice(0, 200), msg: `${e?.message ?? ''}`.slice(0, 200), stack: `${e?.stack ?? ''}`.slice(0, 400) });
  globalThis.__dshComplete(false, `${e?.message ?? e}`);
}
