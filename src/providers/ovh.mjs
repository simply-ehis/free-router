// @body:organ=muscle type=provider role="OVHcloud AI Endpoints adapter: OpenAI-compatible, anonymous keyless tier (2 req/min per IP per model)"
import { enabledKeyEntries } from '../config.mjs';
import { mergeDiscovered } from '../discovery.mjs';
import { listJsonModels } from './listing.mjs';

export const id = 'ovh';
const DEFAULT_BASE = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';
const LIST_TIMEOUT_MS = 30_000;

function base(cfg) {
  const b = cfg?.providers?.ovh?.baseUrl;
  return typeof b === 'string' && b ? b.replace(/\/+$/, '') : DEFAULT_BASE;
}

export function isEnabled(cfg) {
  return cfg.providers?.ovh?.enabled === true;
}

export function listCredentials(cfg) {
  const creds = mergeDiscovered(id, cfg, enabledKeyEntries(cfg.providers?.ovh)
    .map((e) => ({ provider: id, label: `ovh-${e.idx}`, key: e.key })));
  // Anonymous keyless tier: every catalog model is accessible free (2 req/min per IP per model).
  // Empty key → no Authorization header sent, per OVH's anonymous contract.
  creds.push({ provider: id, label: 'anonymous', key: '', source: 'anonymous' });
  return creds;
}

export function protocolOf() {
  return 'chat';
}

export async function listModels(cfg, { signal } = {}) {
  return listJsonModels(`${base(cfg)}/models`, { signal, timeoutMs: LIST_TIMEOUT_MS, label: 'ovh' });
}

export async function listModelIds(cfg, opts) {
  return (await listModels(cfg, opts)).map((m) => m.id);
}

// OVH's anonymous tier serves its whole catalog free (rate-capped); an access
// token lifts the limit. Nothing is free-by-suffix here — anon-tier covers all.
export function freeSources(modelId, freeTable) {
  const sources = ['anon-tier'];
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
