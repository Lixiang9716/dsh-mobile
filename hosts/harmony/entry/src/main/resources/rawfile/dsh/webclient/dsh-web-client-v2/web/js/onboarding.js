// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * onboarding.js — the BYOK first-run panel + the saved-key management face
 * (DOM wiring). main.js calls setupOnboarding({mux, rpc, toast, onReady})
 * once; the panel asks onboarding/status as soon as the mux is open and:
 *
 *   mode mock    → show the panel (no usable credential — the first-run gap)
 *   mode byok    → straight in (已配过直达); the home 模型密钥 button opens
 *                  the MANAGE face — current route summary + onboarding/clear
 *   mode staged  → straight in (the host seat's pre-configured credential);
 *                  the manage face answers informational-only (not removable)
 *   unimplemented → straight in (an older seat without the coverage plane:
 *                  a capability gap, not an error to surface)
 *
 * Test connection opens the onboarding/test mux stream and renders the event
 * sequence (open → delta → done, or one readable error); save posts
 * onboarding/save (the key rides the wire ONCE, into the keychain — never a
 * log line, never plaintext storage) and dismisses into the normal session
 * UI. Clear posts onboarding/clear — no arguments, no key on the wire — and
 * the runtime deletes the keychain ref and restores the boot route live.
 * Bilingual copy throughout (EN + ZH).
 */
import {
  PROVIDERS, PROVIDER_IDS, validateDraft, shouldShowPanel, statusLine,
  readableProbeError, probeLine, saveEnabled, draftFingerprint,
  canClear, manageLine, clearedLine,
} from './onboarding-core.js';
import { isRemoteError } from './api.js';

const $ = (id) => document.getElementById(id);

let probeStreamId = null;
let probeState = 'idle'; // idle | running | passed | failed
let probeFingerprint = null;

const setSaveEnabled = () => {
  $('onboarding-save').disabled = !saveEnabled(
    draftFingerprint(readDraft()), probeFingerprint, probeState);
};

const readDraft = () => {
  const windowText = $('onboarding-context').value.trim();
  return {
    provider: $('onboarding-provider').value,
    baseURL: $('onboarding-baseurl').value.trim(),
    apiKey: $('onboarding-key').value,
    model: $('onboarding-model').value.trim(),
    // Empty = "the provider row's default" (the runtime resolves it; the
    // field rides the wire only when the user overrode it).
    ...(windowText === '' ? {} : { contextWindow: Number(windowText) }),
  };
};

const applyProviderPreset = () => {
  const preset = PROVIDERS[$('onboarding-provider').value] ?? PROVIDERS.deepseek;
  $('onboarding-baseurl').value = preset.baseURL;
  $('onboarding-model').value = preset.model;
  $('onboarding-context').value = String(preset.contextWindow);
};

const setProbeLine = (line) => {
  if (line === null) return;
  $('onboarding-probe-line').textContent = `${line.zh} · ${line.en}`;
};

const setStatusLine = (status) => setProbeLine(statusLine(status));

const failProbe = (error) => {
  probeState = 'failed';
  probeFingerprint = null;
  const readable = readableProbeError(error);
  $('onboarding-probe-line').textContent = `✕ ${readable.zh} · ${readable.en}`;
  setSaveEnabled();
};

/** The test-connection flow: one onboarding/test stream, event-rendered. */
const runProbe = (mux) => {
  const draft = readDraft();
  const invalid = validateDraft(draft);
  if (invalid !== null) {
    failProbe({ code: 'gateway/bad-request', message: `${invalid.field}: ${invalid.why}` });
    return;
  }
  if (probeStreamId !== null) mux.cancel(probeStreamId);
  probeState = 'running';
  $('onboarding-test').disabled = true;
  setSaveEnabled();
  setProbeLine({ en: 'Testing…', zh: '测试中…' });
  probeStreamId = mux.open('onboarding/test', { args: draft }, {
    onItem: (value) => {
      setProbeLine(probeLine(value));
      if (value?.kind === 'probe.done') {
        probeState = 'passed';
        probeFingerprint = draftFingerprint(readDraft());
        $('onboarding-test').disabled = false;
        setSaveEnabled();
      }
    },
    onError: (error) => {
      $('onboarding-test').disabled = false;
      failProbe(error);
    },
    onEnd: () => {
      $('onboarding-test').disabled = false;
      if (probeState !== 'passed') {
        // An end with no done and no error: the stream closed under us.
        if (probeState === 'running') {
          failProbe({ code: 'gateway/unavailable', message: 'probe stream ended early' });
        }
      }
    },
  });
};

/** One attempt to persist + enter. The keychain-unavailable host (an honest
 * capability gap) surfaces the wire error verbatim-ish, bilingually. */
const save = async (rpc, toast, onReady) => {
  const draft = readDraft();
  const invalid = validateDraft(draft);
  if (invalid !== null || !saveEnabled(draftFingerprint(draft), probeFingerprint, probeState)) {
    return;
  }
  $('onboarding-save').disabled = true;
  try {
    await rpc('onboarding/save', { args: draft });
  } catch (error) {
    failProbe(error);
    return;
  }
  // Saved: the keychain holds it, the live route serves it. Enter.
  dismiss(true);
  onReady();
};

let dismiss = () => {};

/** The panel's two faces: the setup form (mock) and the manage face (a
 * saved byok key — summary + remove; staged is informational-only). */
const showForm = () => {
  $('onboarding-manage').hidden = true;
  $('onboarding-form').hidden = false;
};
const showManage = (status) => {
  const line = manageLine(status);
  $('onboarding-manage-line').textContent = `${line.zh} · ${line.en}`;
  $('onboarding-clear').hidden = !canClear(status);
  $('onboarding-manage').hidden = false;
  $('onboarding-form').hidden = true;
};

/** The clear flow: onboarding/clear takes NO arguments — the runtime
 * deletes the keychain ref and restores the boot route live; no key ever
 * rides the wire. The toast confirms; the panel closes (re-opening the
 * button now reaches the setup form — the status answers mock). */
const clear = async (rpc, toast) => {
  $('onboarding-clear').disabled = true;
  try {
    await rpc('onboarding/clear', { args: {} });
  } catch (error) {
    $('onboarding-clear').disabled = false;
    const text = isRemoteError(error)
      ? `移除失败（${error.code}）· Remove failed (${error.code})`
      : '移除失败 · Remove failed';
    toast(text);
    return;
  }
  $('onboarding-clear').disabled = false;
  const line = clearedLine();
  dismiss(false);
  toast(`${line.zh} · ${line.en}`);
};

/** The setup form's static wiring (provider presets, live save-gate, key
 * toggle, test, save, the two close paths). */
const wireForm = (mux, rpc, toast, onReady) => {
  for (const id of PROVIDER_IDS) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = PROVIDERS[id].label;
    $('onboarding-provider').appendChild(option);
  }
  applyProviderPreset();
  $('onboarding-provider').addEventListener('change', () => {
    applyProviderPreset();
    probeState = 'idle';
    probeFingerprint = null;
    setSaveEnabled();
  });
  for (const id of ['onboarding-baseurl', 'onboarding-key', 'onboarding-model', 'onboarding-context']) {
    $(id).addEventListener('input', setSaveEnabled);
  }
  $('onboarding-key-toggle').addEventListener('click', () => {
    const key = $('onboarding-key');
    key.type = key.type === 'password' ? 'text' : 'password';
  });
  $('onboarding-test').addEventListener('click', () => runProbe(mux));
  $('onboarding-save').addEventListener('click', () => save(rpc, toast, onReady));
  $('onboarding-close').addEventListener('click', () => dismiss(false));
  $('onboarding-clear').addEventListener('click', () => clear(rpc, toast));
};

/** The home 模型密钥 button: the configured user's way back in — a saved
 * byok key lands on the manage face, anything else on the setup form. */
const wireModelKeyButton = (rpc, toast, panel) => {
  $('model-key-open').addEventListener('click', async () => {
    let status = null;
    try {
      status = await rpc('onboarding/status');
    } catch (error) {
      if (error?.code === 'gateway/unimplemented') {
        toast('当前环境没有可配置的密钥面 · No credential surface on this seat');
        return;
      }
    }
    if (canClear(status)) showManage(status);
    else { showForm(); setStatusLine(status); }
    panel.hidden = false;
  });
};

/** The panel's entry: called on boot and re-called by main after the mux
 * reconnects? No — once per boot (a configured user never sees it). */
export function setupOnboarding({ mux, rpc, toast, onReady }) {
  const panel = $('onboarding');
  dismiss = (saved) => {
    panel.hidden = true;
    if (!saved) return;
    $('onboarding-key').value = ''; // the page never keeps the key around
  };
  wireForm(mux, rpc, toast, onReady);
  wireModelKeyButton(rpc, toast, panel);

  const detect = async () => {
    let status;
    try {
      status = await rpc('onboarding/status');
    } catch (error) {
      if (error?.code === 'gateway/unimplemented') return; // no coverage plane
      return; // a status failure never blocks the session UI
    }
    setStatusLine(status);
    if (shouldShowPanel(status)) { showForm(); panel.hidden = false; }
  };
  const stop = mux.onStatus((state) => {
    if (state === 'open') detect();
  });
  // The mux may already be open (module ordering) — detect once now too.
  detect();
  return stop;
}
