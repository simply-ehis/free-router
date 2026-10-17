// @body:organ=muscle type=provider role="Hugging Face Inference Providers adapter: OpenAI-compatible, key-required"
import { enabledKeyEntries } from '../config.mjs';
import { mergeDiscovered } from '../discovery.mjs';

export const id = 'huggingface';
const DEFAULT_BASE = 'https://router.huggingface.co/v1';
const LIST_TIMEOUT_MS = 30_000;

function base(cfg) {
  const b = cfg?.providers?.huggingface?.baseUrl;
  return typeof b === 'string' && b ? b.replace(/\/+$/, '') : DEFAULT_BASE;
}

export function isEnabled(cfg) {
  return cfg.providers?.huggingface?.enabled === true;
}

export function listCredentials(cfg) {
  return mergeDiscovered(id, cfg, enabledKeyEntries(cfg.providers?.huggingface)
    .map((e) => ({ provider: id, label: `hf-${e.idx}`, key: e.key })));
}

export function protocolOf() {
  return 'chat';
}

export async function listModelIds(cfg, { signal } = {}) {
  const res = await fetch(`${base(cfg)}/models`, { signal: signal ?? AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`huggingface listModels HTTP ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((m) => m.id).filter(Boolean);
}

// HF router models are paid by underlying provider; free detection from models.dev $0 or runtime 402 demotion.
export function freeSources(modelId, freeTable) {
  const sources = [];
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
