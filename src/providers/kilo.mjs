// @body:organ=muscle type=provider role="Kilo Gateway adapter: OpenAI-compatible universal gateway, anonymous keyless tier for :free models"
import { enabledKeyEntries } from '../config.mjs';
import { mergeDiscovered } from '../discovery.mjs';
import { listJsonModels } from './listing.mjs';

export const id = 'kilo';
const DEFAULT_BASE = 'https://ai-gateway.kilo.ai/api/v1';
const LIST_TIMEOUT_MS = 30_000;

function base(cfg) {
  const b = cfg?.providers?.kilo?.baseUrl;
  return typeof b === 'string' && b ? b.replace(/\/+$/, '') : DEFAULT_BASE;
}

export function isEnabled(cfg) {
  return cfg.providers?.kilo?.enabled === true;
}

export function listCredentials(cfg) {
  const creds = mergeDiscovered(id, cfg, enabledKeyEntries(cfg.providers?.kilo)
    .map((e) => ({ provider: id, label: `kilo-${e.idx}`, key: e.key })));
  // Anonymous keyless tier: free `:free` models need no Authorization header —
  // requests are identified by IP (200 req/hr per IP). Empty key → no header sent.
  creds.push({ provider: id, label: 'anonymous', key: '', source: 'anonymous' });
  return creds;
}

export function protocolOf() {
  return 'chat';
}

export async function listModels(cfg, { signal } = {}) {
  return listJsonModels(`${base(cfg)}/models`, { signal, timeoutMs: LIST_TIMEOUT_MS, label: 'kilo' });
}

export async function listModelIds(cfg, opts) {
  return (await listModels(cfg, opts)).map((m) => m.id);
}

// Kilo tags free models with the `:free` suffix (e.g. z-ai/glm-5:free, minimax/minimax-m2.1:free).
// Paid models need a configured key; the engine falls back through creds on 401.
export function freeSources(modelId, freeTable) {
  const sources = [];
  if (modelId.endsWith(':free')) sources.push('suffix');
  if (freeTable?.[modelId]) sources.push('models.dev');
  return sources;
}

export async function chat(cfg, cred, body, { signal } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cred.key) headers.authorization = `Bearer ${cred.key}`;
  return fetch(`${base(cfg)}/chat/completions`, {
    method: 'POST', signal, headers, body: JSON.stringify(body),
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
