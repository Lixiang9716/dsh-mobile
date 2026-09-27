// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * dsh-office — the Office document plane for hosts that have no office
 * suite: view AND author Word, Excel, and PowerPoint files, entirely in
 * process.
 *
 * The model's surface is eight tools, byte-for-byte the argument contract
 * of dsh-office-tools@1.0.4 (MIT — the desktop cordis plugin this package
 * ports): word_create / word_read / word_update, excel_create / excel_read
 * / excel_update, ppt_create / ppt_read. The engine underneath is that
 * package's hand-rolled OOXML, re-based from node:zlib + node:path + the
 * ctx.fs service onto vendored fflate (the zip container) and the gateway's
 * fs primitives over the pinned profile workspace — the same adaptation
 * seam every system plugin uses (dsh-open-design ports open-design-mcp the
 * same way). The official @deepseek-ai/dsh-skill-office is the OTHER
 * upstream face: a skill package whose workflows shell out to python
 * scripts — no subprocess here, so it is deliberately not mounted; see the
 * feature Agent Note for the survey.
 *
 * No configuration and no gating: the tools need only the fs primitives
 * every host grants, so they are always offered.
 */
import { createLogger } from 'logger.js';
import { registerWordTools } from './word.js';
import { registerExcelTools } from './excel.js';
import { registerPptCreate } from './ppt-create.js';
import { registerPptRead } from './ppt-read.js';

const log = createLogger('dsh.office');

export const manifest = {
  schemaVersion: 1,
  id: 'dsh-office',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['fsRead', 'fsWrite', 'fsStat'], optional: [] },
  hooks: { activate: 'activate' },
};

export function activate() {
  log.info('office tools activating (word/excel/ppt over the gateway fs)', {});
}

/** The spine's mount shape (boot.js): register the eight tools into the
 * ToolRuntime. No decline path — unlike open-design there is no daemon to
 * configure; the capability set is the fs trio every host grants. */
export const name = 'dsh-office';
export const inject = ['tools'];

export const apply = (ctx) => {
  const tools = [
    ...registerWordTools(),
    ...registerExcelTools(),
    registerPptCreate(),
    registerPptRead(),
  ];
  for (const tool of tools) ctx.tools.register(tool);
  log.info('office tools registered', { count: tools.length });
};
