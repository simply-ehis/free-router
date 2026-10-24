// @body:organ=muscle type=provider role="Cloudflare Workers AI adapter: free neuron pool, OpenAI-compatible"
import { enabledKeyEntries } from '../config.mjs';
import { mergeDiscovered } from '../discovery.mjs';
import { listJsonModels } from './listing.mjs';

export const id = 'cloudflare';
const DEFAULT_ACCOUNT = '';
const LIST_TIMEOUT_MS = 30_000;

function accountId(cfg) {
  return cfg?.providers?.cloudflare?.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || '';
}

function base(cfg) {
  const a = accountId(cfg);
  return a ? `https://api.cloudflare.com/client/v4/accounts/${a}/ai/v1` : '';
}

export function isEnabled(cfg) {
  return cfg.providers?.cloudflare?.enabled === true && !!base(cfg);
}

export function listCredentials(cfg) {
  return mergeDiscovered(id, cfg, enabledKeyEntries(cfg.providers?.cloudflare)
    .map((e) => ({ provider: id, label: `cf-${e.idx}`, key: e.key })));
}

export function protocolOf() {
  return 'chat';
}

export async function listModels(cfg, { signal } = {}) {
  const b = base(cfg);
  if (!b) throw new Error('cloudflare listModels requires accountId (providers.cloudflare.accountId or CLOUDFLARE_ACCOUNT_ID)');
  return listJsonModels(`${b}/models`, { signal, timeoutMs: LIST_TIMEOUT_MS, label: 'cloudflare', pick: (json) => json?.result ?? json?.data ?? json?.models });
}

export async function listModelIds(cfg, opts) {
  return (await listModels(cfg, opts)).map((m) => m.id);
}

export function freeSources() {
  return ['free-tier'];
}

export async function chat(cfg, cred, body, { signal } = {}) {
  const b = base(cfg);
  return fetch(`${b}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.key}` },
    body: JSON.stringify(body),
  });
}

export function classifyError(status, text = '') {
  const t = text.toLowerCase();
  if (status === 402 || /insufficient|balance|credit|billing|neuron/.test(t)) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'ratelimit';
  if (status === 404 || status === 400) return 'notfound';
  if (status >= 500) return 'transient';
  return 'unknown';
}
