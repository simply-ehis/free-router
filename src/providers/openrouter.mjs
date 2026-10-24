// @body:organ=muscle type=provider role="OpenRouter adapter: :free-suffix + zero-priced models"
import { enabledKeyEntries } from '../config.mjs';
import { mergeDiscovered } from '../discovery.mjs';
import { listJsonModels } from './listing.mjs';

export const id = 'openrouter';
const DEFAULT_BASE = 'https://openrouter.ai/api/v1';
const LIST_TIMEOUT_MS = 30_000;

// Zero-priced ids from the last /models listing — OpenRouter prices are
// strings ("0"), so models.dev opencode-table matches rarely apply here.
let zeroPriced = new Set();

function base(cfg) {
  const b = cfg?.providers?.openrouter?.baseUrl;
  return typeof b === 'string' && b ? b.replace(/\/+$/, '') : DEFAULT_BASE;
}

export function isEnabled(cfg) {
  return cfg.providers?.openrouter?.enabled === true;
}

export function listCredentials(cfg) {
  return mergeDiscovered(id, cfg, enabledKeyEntries(cfg.providers?.openrouter)
    .map((e) => ({ provider: id, label: `or-${e.idx}`, key: e.key })));
}

export function protocolOf() {
  return 'chat';
}

export async function listModels(cfg, { signal } = {}) {
  const rows = await listJsonModels(`${base(cfg)}/models`, { signal, timeoutMs: LIST_TIMEOUT_MS, label: 'openrouter' });
  zeroPriced = new Set();
  for (const { id: modelId, meta } of rows) {
    const p = meta.pricing;
    if (p && Number(p.prompt) === 0 && Number(p.completion) === 0) zeroPriced.add(modelId);
  }
  return rows;
}

export async function listModelIds(cfg, opts) {
  return (await listModels(cfg, opts)).map((m) => m.id);
}

export function freeSources(modelId, freeTable) {
  const sources = [];
  if (modelId.endsWith(':free')) sources.push('suffix');
  if (zeroPriced.has(modelId)) sources.push('zero-priced');
  if (freeTable?.[modelId]) sources.push('models.dev');
  return sources;
}

export async function chat(cfg, cred, body, { signal } = {}) {
  return fetch(`${base(cfg)}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cred.key}`,
      'http-referer': `http://${cfg.host}:${cfg.port}`,
      'x-title': cfg.name ?? 'free-router',
    },
    body: JSON.stringify(body),
  });
}

export function classifyError(status, text = '') {
  const t = text.toLowerCase();
  if (status === 410 || /deprecated/.test(t)) return 'deprecated';
  if (status === 402 || /insufficient|balance|credit/.test(t)) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'ratelimit';
  if (status === 404 || status === 400) return 'notfound';
  if (status >= 500) return 'transient';
  return 'unknown';
}
