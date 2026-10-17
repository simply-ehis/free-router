// @body:organ=muscle type=provider role="LLM7.io adapter: OpenAI-compatible, key-optional free tier (anonymous `unused` key, 10 req/min on turbo models)"
import { enabledKeyEntries } from '../config.mjs';
import { mergeDiscovered } from '../discovery.mjs';

export const id = 'llm7';
const DEFAULT_BASE = 'https://api.llm7.io/v1';
const LIST_TIMEOUT_MS = 30_000;

function base(cfg) {
  const b = cfg?.providers?.llm7?.baseUrl;
  return typeof b === 'string' && b ? b.replace(/\/+$/, '') : DEFAULT_BASE;
}

export function isEnabled(cfg) {
  return cfg.providers?.llm7?.enabled === true;
}

export function listCredentials(cfg) {
  const creds = mergeDiscovered(id, cfg, enabledKeyEntries(cfg.providers?.llm7)
    .map((e) => ({ provider: id, label: `llm7-${e.idx}`, key: e.key })));
  // Key-optional free tier: the placeholder key `unused` works with no account
  // (10 req/min on turbo models). A real LLM7 token lifts the limit.
  creds.push({ provider: id, label: 'anonymous', key: 'unused', source: 'anonymous' });
  return creds;
}

export function protocolOf() {
  return 'chat';
}

export async function listModelIds(cfg, { signal } = {}) {
  const res = await fetch(`${base(cfg)}/models`, { signal: signal ?? AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`llm7 listModels HTTP ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((m) => m.id).filter(Boolean);
}

// LLM7's free token tier covers its turbo models; pro models need a balance.
// Marking everything free-tier lets the engine try and demote on 402/401.
export function freeSources() {
  return ['free-tier'];
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
