/**
 * dsh-ui — system implementation plugin for the `ui` service (M2 v0).
 *
 * Composes the native-UI contract primitives into the session-facing surface:
 * approval → presentApproval ({approved, remember}), picker → presentPicker
 * ({scope, path} or null on dismissal), and notify → notify() PLUS the
 * notify.response round trip (the promise settles from the response EVENT —
 * event-driven, never a blocking whole-result call, D8).
 */
import { createLogger } from 'logger.js';
import { notify, onEvent, presentApproval, presentPicker } from 'gateway.js';

const log = createLogger('dsh.ui');

/** The static manifest this plugin installs under (schemaVersion 1). */
export const manifest = {
  schemaVersion: 1,
  id: 'dsh-ui',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['notify', 'presentApproval', 'presentPicker'], optional: [] },
  hooks: { activate: 'activate' },
};

/** Routes bridge events to the one waiter matching a notification id. */
const makeResponses = () => {
  const waiters = new Map(); // id → resolve
  onEvent((ev) => {
    if (ev.event !== 'notify.response') return;
    log.debug('notify.response seen', { id: ev.id });
    const wake = waiters.get(ev.id);
    if (wake) {
      waiters.delete(ev.id);
      wake(ev);
    }
  });
  return {
    await: (id) => {
      log.debug('await notify.response', { id });
      return new Promise((resolve) => waiters.set(id, resolve));
    },
  };
};

/** Activation hook (manifest.hooks.activate): registers the `ui` service. */
export function activate({ register }) {
  log.debug('activating dsh-ui');
  const responses = makeResponses();

  /** approval: resolves {approved, remember?} with the user's decision. */
  const approval = async (req) => {
    log.debug('ui.approval', { title: req.title });
    return await presentApproval(req);
  };

  /** picker: resolves {scope, path} — or null when the user dismisses. */
  const picker = async (req) => {
    log.debug('ui.picker', { mode: req.mode });
    return await presentPicker(req);
  };

  /** notify: schedules the notification, then settles on its response event
   * ({id, action?}). Unmatched responses (other ids) pass through untouched. */
  const notifyAndWait = async (payload) => {
    const scheduled = await notify(payload);
    log.debug('ui.notify scheduled', { id: scheduled.id });
    const response = await responses.await(scheduled.id);
    return { id: scheduled.id, action: response.action };
  };

  register('ui', { approval, picker, notify: notifyAndWait });
}
