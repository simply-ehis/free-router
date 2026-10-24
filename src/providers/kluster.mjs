// @body:organ=muscle type=provider role="Kluster.ai adapter: OpenAI-compatible, key-required"
import { enabledKeyEntries } from '../config.mjs';
import { mergeDiscovered } from '../discovery.mjs';
import { listJsonModels } from './listing.mjs';

export const id = 'kluster';
const DEFAULT_BASE = 'https://api.kluster.ai/v1';
const LIST_TIMEOUT_MS = 30_000;

function base(cfg) {
  const b = cfg?.providers?.kluster?.baseUrl;
  return typeof b === 'string' && b ? b.replace(/\/+$/, '') : DEFAULT_BASE;
}

export function isEnabled(cfg) {
  return cfg.providers?.kluster?.enabled === true;
}

export function listCredentials(cfg) {
  return mergeDiscovered(id, cfg, enabledKeyEntries(cfg.providers?.kluster)
    .map((e) => ({ provider: id, label: `kluster-${e.idx}`, key: e.key })));
}

export function protocolOf() {
  return 'chat';
}

export async function listModels(cfg, { signal } = {}) {
  return listJsonModels(`${base(cfg)}/models`, { signal, timeoutMs: LIST_TIMEOUT_MS, label: 'kluster' });
}

export async function listModelIds(cfg, opts) {
  return (await listModels(cfg, opts)).map((m) => m.id);
}

// Kluster models are paid; free detection from models.dev $0 or runtime 402 demotion.
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
