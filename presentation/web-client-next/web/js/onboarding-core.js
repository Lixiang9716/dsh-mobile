// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * onboarding-core.js — the BYOK onboarding panel's PURE logic (no DOM), so
 * the vitest suite imports it directly. The runtime-side mirror lives in
 * runtime/spike/upstream/llm-route.js (this repo mirrors page-side
 * vocabulary deliberately — the page bundle never imports runtime code).
 *
 * Bilingual copy is EN-first data here ({en, zh}); the panel renders both.
 */

/** The provider rows: DeepSeek's first-party OpenAI-compatible endpoint and
 * the bring-your-own OpenAI-compatible row. Mirrors the runtime's
 * BYOK_PROVIDERS. */
export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    baseURLFixed: false,
  },
  'openai-compatible': {
    label: 'OpenAI 兼容 / OpenAI-compatible',
    baseURL: '',
    model: '',
    baseURLFixed: false,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

const URL_PATTERN = /^https?:\/\/[^\s]+$/;

/** Validate one draft {provider, baseURL, apiKey, model} → {field, why} |
 * null. Same grammar the runtime's save leg enforces — a draft the panel
 * accepts never bounces at the wire. */
export function validateDraft(draft) {
  if (!PROVIDER_IDS.includes(draft?.provider)) {
    return { field: 'provider', why: 'unknown provider 未知 provider' };
  }
  if (typeof draft.baseURL !== 'string' || !URL_PATTERN.test(draft.baseURL)) {
    return { field: 'baseURL', why: 'enter an http(s) URL 请输入 http(s) 地址' };
  }
  if (typeof draft.apiKey !== 'string' || draft.apiKey.trim().length === 0) {
    return { field: 'apiKey', why: 'paste your key 请粘贴密钥' };
  }
  if (draft.apiKey.length > 512) {
    return { field: 'apiKey', why: 'key too long (max 512) 密钥过长(上限 512)' };
  }
  if (typeof draft.model !== 'string' || draft.model.trim().length === 0) {
    return { field: 'model', why: 'name a model 请填写模型 id' };
  }
  if (draft.model.length > 128) {
    return { field: 'model', why: 'model id too long (max 128) 模型 id 过长' };
  }
  return null;
}

/** Whether the panel shows for one onboarding/status answer: only a boot
 * with NO usable credential (the scripted mock route) onboards. Configured
 * users (byok or a staged credential) go straight in. */
export function shouldShowPanel(status) {
  return status?.mode === 'mock';
}

/** Whether the saved credential is removable through onboarding/clear: only
 * the panel's OWN keychain ref (mode byok). A staged credential belongs to
 * the host seat — removal is not this panel's to offer; mock has nothing to
 * remove. */
export function canClear(status) {
  return status?.mode === 'byok';
}

/** The manage view's one-line summary (a configured user who opens the
 * panel from the home button sees this, not the setup form). Carries the
 * same facts onboarding/status does — never key material. */
export function manageLine(status) {
  switch (status?.mode) {
    case 'byok':
      return {
        en: `Your ${status.provider} key is saved — requests go to ${status.baseURL}`,
        zh: `已保存你的 ${status.provider} 密钥 — 请求发往 ${status.baseURL}`,
      };
    case 'staged':
      return {
        en: 'This device uses the pre-configured endpoint (not removable here)',
        zh: '本机使用预配置端点(此处不可移除)',
      };
    default:
      return { en: 'No model credential yet', zh: '尚未配置模型密钥' };
  }
}

/** The confirmation line after onboarding/clear succeeds. Honest about the
 * live-session semantics: sessions created under the removed route keep
 * their binding; NEW sessions take the restored default route. */
export function clearedLine() {
  return {
    en: 'Saved key removed — new sessions take the default route',
    zh: '已移除保存的密钥 — 新会话走默认路由',
  };
}

/** The panel's one-line status subtitle for a status answer. */
export function statusLine(status) {
  switch (status?.mode) {
    case 'byok':
      return { en: `Using your ${status.provider} endpoint`, zh: `已使用你的 ${status.provider} 端点` };
    case 'staged':
      return { en: 'Using the pre-configured endpoint', zh: '已使用预配置端点' };
    default:
      return { en: 'No model credential yet — set your own key to start', zh: '尚未配置模型密钥 — 配置你自己的 key 即可开始' };
  }
}

/** Map one probe failure (the wire's {code, message}) to a readable
 * bilingual pair. The runtime keeps its messages factual (the HTTP status
 * rides inside streamChat's message); the page owns the human words. */
export function readableProbeError(error) {
  const message = String(error?.message ?? error ?? '');
  const statusMatch = /status (\d{3})/.exec(message);
  const status = statusMatch === null
    ? Number(error?.details?.httpStatus ?? 0) : Number(statusMatch[1]);
  if (status === 401 || status === 403) {
    return { en: `The key was rejected (HTTP ${status}) — check it and retry`,
      zh: `密钥被拒绝(HTTP ${status})— 请检查后重试` };
  }
  if (status === 404) {
    return { en: 'Endpoint or model not found (HTTP 404) — check the baseURL and model id',
      zh: '端点或模型不存在(HTTP 404)— 请检查 baseURL 与模型 id' };
  }
  if (status >= 500 && status <= 599) {
    return { en: `The provider had a server error (HTTP ${status}) — retry shortly`,
      zh: `服务端错误(HTTP ${status})— 请稍后重试` };
  }
  if (/only http:\/\/127\.0\.0\.1/.test(message)) {
    return { en: 'This build reaches loopback endpoints only (a CLI/dev host)',
      zh: '当前环境仅可访问 loopback 端点(CLI/开发宿主)' };
  }
  if (error?.code === 'gateway/unavailable' || /fetch|network|refused|timeout/i.test(message)) {
    return { en: 'Could not reach the endpoint — check the URL and your network',
      zh: '无法连接端点 — 请检查地址与网络' };
  }
  return { en: message.slice(0, 200), zh: message.slice(0, 200) };
}

/** The probe feedback line for one streamed event (open/delta/done). */
export function probeLine(event) {
  switch (event?.kind) {
    case 'probe.open':
      return { en: `Connected (HTTP ${event.status}) — waiting for the first token…`,
        zh: `已连接(HTTP ${event.status})— 等待首 token…` };
    case 'probe.delta':
      return { en: 'Receiving tokens…', zh: '正在接收 token…' };
    case 'probe.done':
      return { en: `Test passed — the model answered (${event.chars} chars)`,
        zh: `测试通过 — 模型已应答(${event.chars} 字符)` };
    default:
      return null;
  }
}

/** The save button's gate: enabled only after a completed probe with the
 * CURRENT draft values (a stale pass must not save a changed draft). */
export function saveEnabled(draftFingerprint, probeFingerprint, probeState) {
  return probeState === 'passed' && draftFingerprint === probeFingerprint;
}

/** One stable fingerprint of the credential-bearing fields. The key enters
 * only as an FNV-1a digest — the fingerprint may land in diagnostics
 * (muxDiag), so the key's VALUE never appears in any string this page can
 * produce. */
export function draftFingerprint(draft) {
  let hash = 0x811c9dc5;
  const key = String(draft?.apiKey ?? '');
  for (let at = 0; at < key.length; at++) {
    hash ^= key.charCodeAt(at);
    hash = (hash * 0x01000193) >>> 0;
  }
  return [draft?.provider ?? '', draft?.baseURL ?? '', draft?.model ?? '', hash.toString(16)].join('\u0000');
}
