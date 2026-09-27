import { createLogger } from 'logger.js';
import { fsScope } from 'gateway.js';
import 'upstream/shims/npm-bridges.js';
const log = createLogger('v2');
const root = await fsScope.resolve();
globalThis.__dshProfileScopeRoot = root.path;
globalThis.__dshProfileCwd = root.path;
const { registerWordTools } = await import('system-plugins/dsh-office/word.js');
const { registerExcelTools } = await import('system-plugins/dsh-office/excel.js');
const { registerPptCreate } = await import('system-plugins/dsh-office/ppt-create.js');
log.info('v2', { step: 'imports-done' });
const [wc] = registerWordTools();
const [ec] = registerExcelTools();
const [pc] = registerPptCreate();
log.info('v2', { step: 'all-registered' });
try { await wc.execute({ path: 'val.docx', title: 'Validation Doc', paragraphs: ['Body one.', 'Body two.'], bullets: ['b1', 'b2'], table: { headers: ['H1', 'H2'], rows: [['a', 'b'], ['c', 'd']] } }); } catch (e) { log.info('v2', { step: 'docx-err', msg: `${e?.message ?? e}`, stack: `${e?.stack ?? ''}`.slice(0, 300) }); }
log.info('v2', { step: 'docx-done' });
let ex; try { ex = await ec.execute({ path: 'val.xlsx', sheets: [{ name: 'S1', rows: [['Name', 'N', 'Flag'], ['x', 7, true], ['y', 2.5, false]] }] }); } catch (e) { log.info('v2', { step: 'xlsx-err', msg: `${e?.message ?? e}` }); }
log.info('v2', { step: 'xlsx-done' });
try { await pc.execute({ path: 'val.pptx', title: 'Validation Deck', slides: [{ title: 'Slide A', bullets: ['p1', 'p2'], notes: 'note text' }] }); } catch (e) { log.info('v2', { step: 'pptx-err', msg: `${e?.message ?? e}` }); }
log.info('v2', { step: 'pptx-done', root: root.path });
