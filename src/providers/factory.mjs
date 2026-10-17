// @body:organ=muscle type=provider role="OpenAI-compatible provider factory: one adapter implementation for any base-URL+key endpoint (free-tier presets)"
import { enabledKeyEntries } from '../config.mjs';
import { mergeDiscovered } from '../discovery.mjs';

const LIST_TIMEOUT_MS = 30_000;

function classify(status, text = '') {
  const t = text.toLowerCase();
  if (status === 410 || /deprecated/.test(t)) return 'deprecated';
  if (status === 402 || /insufficient|balance|credit|billing/.test(t)) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || /rate.?limit/.test(t)) return 'ratelimit';
  if (status === 404 || status === 400) return 'notfound';
  if (status >= 500) return 'transient';
  return 'unknown';
}

// Every preset is the same contract: keys in `providers.<id>.keys` (plus env
// discovery), `baseUrl` overridable, OpenAI-shaped /models + /chat/completions.
// The free-tier claim mirrors Groq: the key's default developer tier; a key
// with paid billing attached is the caller's responsibility (runtime demotion
// catches billing-class errors).
export function makeOpenAIProvider({ id, defaultBase, freeSources: sourcesFor = () => ['free-tier'] }) {
  const base = (cfg) => {
    const b = cfg?.providers?.[id]?.baseUrl;
    return typeof b === 'string' && b ? b.replace(/\/+$/, '') : defaultBase;
  };
  const listCredentials = (cfg) => mergeDiscovered(id, cfg, enabledKeyEntries(cfg.providers?.[id])
    .map((e) => ({ provider: id, label: `${id}-${e.idx}`, key: e.key })));
  return {
    id,
    defaultBase,
    isEnabled: (cfg) => cfg.providers?.[id]?.enabled === true,
    listCredentials,
    protocolOf: () => 'chat',
    listModelIds: async (cfg, { signal } = {}) => {
      const cred = listCredentials(cfg)[0];
      const res = await fetch(`${base(cfg)}/models`, {
        signal: signal ?? AbortSignal.timeout(LIST_TIMEOUT_MS),
        headers: cred ? { authorization: `Bearer ${cred.key}` } : {},
      });
      if (!res.ok) throw new Error(`${id} listModels HTTP ${res.status}`);
      const json = await res.json();
      return (json.data ?? []).map((m) => m?.id).filter((v) => typeof v === 'string' && v.length > 0);
    },
    freeSources: (modelId, freeTable) => sourcesFor(modelId, freeTable),
    chat: (cfg, cred, body, { signal } = {}) => fetch(`${base(cfg)}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.key}` },
      body: JSON.stringify(body),
    }),
    classifyError: classify,
  };
}
