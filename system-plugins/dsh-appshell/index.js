// dsh:logging-exempt — the mounted logger carries every canonical line.
/**
 * dsh-appshell: one-prompt app surfaces. The model authors an app-shell spec
 * (declarative component tree, app-shell/0.9); the client renders it with its
 * own catalog. Zero gateway primitives — specs ride session content.
 *
 * Mock/real switch: DSH_APPSHELL_MODE=mock serves bundled fixtures
 * (lib/mock.js); real validates model tool-call args. Both feed the SAME
 * validate->expand->render pipeline (lib/render.js).
 */
import { createLogger } from 'logger.js';
import { MODE, modeAnnounce, mockSpec, fixtureKeys } from './lib/mock.js';
import { validate } from './lib/validate.js';
import { SPEC_VERSION } from './lib/catalog.js';

const log = createLogger('dsh.appshell');

export const name = 'dsh-appshell';
export const inject = ['tools'];

const RULES = 'Author an app-shell spec: {"spec":"' + SPEC_VERSION + '",theme:{accent},tabs:[2..5 strings],actions:[ids],screen:node}. ' +
  'Node types (closed): text,image,button,row,column,card,progressbar,badge + templates search-bar,tab-bar,chat-row,service-grid,banner-card,hcard-row,balance-card,mini-player. ' +
  'Every button.action must be declared in actions. Text fields are plain text. Call appshell_catalog for the full rules.';

function verdict(result) {
  return result.ok ? { ok: true } : { ok: false, errors: result.errors };
}

export function apply(ctx) {
  modeAnnounce(log);
  ctx.tools?.register?.({
    name: 'appshell_render',
    description: 'Render a full app surface from an app-shell spec. ' + RULES +
      (MODE === 'mock' ? ' [MOCK MODE: arg {fixture:"wechat"|"netease"|"alipay"} serves a bundled fixture instead.]' : ''),
    parameters: MODE === 'mock'
      ? { fixture: { type: 'string', desc: 'fixture key: ' + fixtureKeys().join('|') } }
      : { spec: { type: 'object', desc: 'the app-shell spec object' } },
    execute: async (args) => {
      if (MODE === 'mock') {
        const spec = mockSpec(args.fixture || 'wechat');
        if (!spec) return 'unknown fixture; keys: ' + fixtureKeys().join('|');
        log.info({ event: 'appshell.render', mode: MODE, fixture: args.fixture || 'wechat' });
        // Echo the spec: any client renders from the result payload — the
        // same contract in mock and real mode (source differs, shape equal).
        return JSON.stringify({ ok: true, title: args.fixture || 'wechat', spec });
      }
      const result = validate(args.spec);
      log.info({ event: 'appshell.render', mode: MODE, ok: result.ok, errors: result.errors.length });
      if (!result.ok) return 'spec rejected: ' + JSON.stringify(result.errors);
      return JSON.stringify({ ok: true, title: args.spec.title || 'app', spec: args.spec });
    },
  });

  ctx.tools?.register?.({
    name: 'appshell_update',
    description: 'Update a subtree of an already-rendered app surface (same surfaceId). Same spec rules.',
    parameters: { surfaceId: { type: 'string', desc: 'the surface to update' }, spec: { type: 'object', desc: 'the new app-shell spec' } },
    execute: async (args) => {
      const result = validate(args.spec);
      log.info({ event: 'appshell.update', mode: MODE, surfaceId: String(args.surfaceId || '').slice(0, 64), ok: result.ok });
      return result.ok ? 'surface updated' : 'spec rejected: ' + JSON.stringify(result.errors);
    },
  });

  ctx.tools?.register?.({
    name: 'appshell_catalog',
    description: 'Return the full app-shell component catalog and authoring rules.',
    parameters: {},
    execute: async () => RULES,
  });
}

/** Test/inspection seam: the activate hook the manifest names. */
export function activate({ register }) {
  register('appshell', {
    render: (spec) => verdict(validate(spec)),
    mode: MODE,
  });
}
