// @body:organ=muscle type=provider role="Z.AI (Zhipu) adapter: OpenAI-compatible GLM models, key-required free tier"
import { enabledKeyEntries } from '../config.mjs';
import { mergeDiscovered } from '../discovery.mjs';

export const id = 'zai';
const DEFAULT_BASE = 'https://api.z.ai/api/paas/v4/';
const LIST_TIMEOUT_MS = 30_000;

function base(cfg) {
  const b = cfg?.providers?.zai?.baseUrl;
  return typeof b === 'string' && b ? b.replace(/\/+$/, '') : DEFAULT_BASE;
}

export function isEnabled(cfg) {
  return cfg.providers?.zai?.enabled === true;
}

export function listCredentials(cfg) {
  return mergeDiscovered(id, cfg, enabledKeyEntries(cfg.providers?.zai)
    .map((e) => ({ provider: id, label: `zai-${e.idx}`, key: e.key })));
}

export function protocolOf() {
  return 'chat';
}

export async function listModelIds(cfg, { signal } = {}) {
  const res = await fetch(`${base(cfg)}/models`, { signal: signal ?? AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`zai listModels HTTP ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((m) => m.id).filter(Boolean);
}

// Free models per Z.AI pricing: -flash variants, GLM-4.5/4.6/4.7/5.1 series,
// and -turbo (cheaper reasoning variant). Flagship non-flash 5.x models
// (glm-5.3, glm-5.2, glm-5) are paid. Runtime demotion (402) removes any
// model that turns out not to be free.
export function freeSources(modelId, freeTable) {
  const sources = [];
  const lower = modelId.toLowerCase();
  if (lower.includes('-flash') || lower.endsWith('-free') || lower.includes('-turbo')) sources.push('suffix');
  if (/glm-4\.[567]/i.test(modelId) || /glm-5\.[12]/i.test(modelId) || /glm-5-turbo/i.test(modelId)) sources.push('known-free');
  if (freeTable?.[modelId]) sources.push('models.dev');
  return sources;
}

export async function chat(cfg, cred, body, { signal } = {}) {
  return fetch(`${base(cfg)}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.key}` },
    body: JSON.stringify(body),
  });
}

export function classifyError(status, text = '') {
  const t = text.toLowerCase();
  if (status === 410 || /deprecated/.test(t)) return 'deprecated';
  if (status === 402 || /insufficient|balance|credit|billing/.test(t)) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || /rate.?limit/.test(t)) return 'ratelimit';
  if (status === 404 || status === 400) return 'notfound';
  if (status >= 500) return 'transient';
  return 'unknown';
}
