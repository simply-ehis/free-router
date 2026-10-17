// @body:organ=muscle type=provider role="Google AI Studio adapter: native model list + OpenAI-compatible chat (free rate-limited tier)"
import { enabledKeyEntries } from '../config.mjs';
import { mergeDiscovered } from '../discovery.mjs';

export const id = 'gemini';
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const LIST_TIMEOUT_MS = 30_000;

function base(cfg) {
  const b = cfg?.providers?.gemini?.baseUrl;
  return typeof b === 'string' && b ? b.replace(/\/+$/, '') : DEFAULT_BASE;
}

export function isEnabled(cfg) {
  return cfg.providers?.gemini?.enabled === true;
}

export function listCredentials(cfg) {
  return mergeDiscovered(id, cfg, enabledKeyEntries(cfg.providers?.gemini)
    .map((e) => ({ provider: id, label: `gemini-${e.idx}`, key: e.key })));
}

export function protocolOf() {
  return 'chat';
}

// The OpenAI-compat surface has no /models route (404, verified); listing uses
// the native endpoint which requires a key. Model ids are "models/<id>" there —
// stripped so client requests match the OpenAI-compat chat route.
export async function listModelIds(cfg, { signal } = {}) {
  const cred = listCredentials(cfg)[0];
  if (!cred) throw new Error('gemini listModels requires a key (FREE_ROUTER_GEMINI_KEYS or GEMINI_API_KEY)');
  const res = await fetch(`${base(cfg)}/models`, {
    signal: signal ?? AbortSignal.timeout(LIST_TIMEOUT_MS),
    headers: { 'x-goog-api-key': cred.key },
  });
  if (!res.ok) throw new Error(`gemini listModels HTTP ${res.status}`);
  const json = await res.json();
  return (json.models ?? [])
    .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);
}

// AI Studio keys are the rate-limited free tier by default; keys with Cloud
// billing attached are the caller's responsibility. Runtime demotion catches
// billing-class errors where the API reports them.
export function freeSources() {
  return ['free-tier'];
}

export async function chat(cfg, cred, body, { signal } = {}) {
  return fetch(`${base(cfg)}/openai/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cred.key}`,
      'x-goog-api-key': cred.key,
    },
    body: JSON.stringify(body),
  });
}

export function classifyError(status, text = '') {
  const t = text.toLowerCase();
  if (status === 410 || /deprecated/.test(t)) return 'deprecated';
  if (status === 402 || /insufficient|balance|credit|billing/.test(t)) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || /quota|rate.?limit/.test(t)) return 'ratelimit';
  if (status === 404 || status === 400) return 'notfound';
  if (status >= 500) return 'transient';
  return 'unknown';
}
