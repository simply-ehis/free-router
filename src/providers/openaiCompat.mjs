// @body:organ=muscle type=provider role="generic OpenAI-compatible adapter: multi-instance /models + chat passthrough"
import { mergeDiscovered } from '../discovery.mjs';

export const id = 'openai-compat';
const LIST_TIMEOUT_MS = 30_000;

function instances(cfg) {
  return (cfg.providers?.[id]?.instances ?? []).filter(
    (inst) => inst?.enabled !== false && typeof inst?.baseUrl === 'string' && /^https?:\/\//.test(inst.baseUrl),
  );
}

export function isEnabled(cfg) {
  return cfg.providers?.[id]?.enabled === true && instances(cfg).length > 0;
}

export function listCredentials(cfg) {
  const out = [];
  for (const inst of instances(cfg)) {
    if (typeof inst.apiKey === 'string' && inst.apiKey.length > 0) {
      out.push({ provider: id, label: inst.name || inst.prefix || 'compat', key: inst.apiKey, instance: inst });
    }
  }
  return mergeDiscovered(id, cfg, out);
}

export function protocolOf() {
  return 'chat';
}

// Model ids served to clients are `${prefix}:${upstreamId}` so multiple
// instances (and other providers) never collide in the catalog.
export async function listModelIds(cfg, { signal } = {}) {
  const ids = [];
  for (const inst of instances(cfg)) {
    const prefix = inst.prefix ? `${inst.prefix}:` : '';
    if (Array.isArray(inst.models) && inst.models.length > 0) {
      for (const m of inst.models) ids.push(prefix + m);
      continue;
    }
    const base = inst.baseUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/models`, {
      signal: signal ?? AbortSignal.timeout(LIST_TIMEOUT_MS),
      headers: inst.apiKey ? { authorization: `Bearer ${inst.apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`openai-compat(${inst.name || inst.prefix || base}) listModels HTTP ${res.status}`);
    const json = await res.json();
    for (const m of json.data ?? []) if (typeof m?.id === 'string') ids.push(prefix + m.id);
  }
  return ids;
}

// Compat sources make no free claims — open-pool surfaces them; billing
// demotion (402 → out of rotation) is the cost safety net.
export function freeSources() {
  return [];
}

function upstreamModel(cred, modelId) {
  const prefix = cred?.instance?.prefix;
  if (prefix && modelId.startsWith(`${prefix}:`)) return modelId.slice(prefix.length + 1);
  return modelId;
}

// Raw Response passthrough — stream and non-stream both relayed untouched
// (the engine already reassembles/aggregates upstream SSE as needed).
export async function chat(cfg, cred, body, { signal } = {}) {
  const base = String(cred.instance?.baseUrl ?? '').replace(/\/+$/, '');
  return fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.key}` },
    body: JSON.stringify({ ...body, model: upstreamModel(cred, body.model) }),
  });
}

export function classifyError(status, text = '') {
  const t = text.toLowerCase();
  if (status === 402 || /insufficient|balance|payment|billing|credit/.test(t)) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'ratelimit';
  if (status === 404 || status === 400) return 'notfound';
  if (status >= 500) return 'transient';
  return 'unknown';
}
