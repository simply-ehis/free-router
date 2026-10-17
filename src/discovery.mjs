// @body:organ=muscle type=discovery role="ephemeral key discovery: env vars + opencode auth.json (never persisted)"
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Env var names per native provider; multiple aliases accepted per provider.
const ENV_KEYS = {
  zen: ['ZEN_API_KEY', 'OPENCODE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  sambanova: ['SAMBANOVA_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  kilo: ['KILO_API_KEY'],
  ovh: ['OVH_AI_ENDPOINTS_ACCESS_TOKEN', 'AI_ENDPOINT_API_KEY'],
  llm7: ['LLM7_API_KEY'],
  zai: ['ZAI_API_KEY', 'Z_AI_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
  kluster: ['KLUSTER_API_KEY'],
  huggingface: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
};

// opencode auth.json provider ids → our provider ids. Unknown ids ignored (no adapter).
const AUTH_MAP = { opencode: 'zen', openrouter: 'openrouter', groq: 'groq', gemini: 'gemini', google: 'gemini' };

export function authJsonPath() {
  return process.env.FREE_ROUTER_AUTH_JSON
    || path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
}

function readAuthEntries(authPath) {
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) return [];
    return Object.entries(auth).filter(([, v]) => typeof v?.key === 'string' && v.key.length > 10);
  } catch {
    return [];
  }
}

// Sync and cheap (env read + one small file). Keys are returned ephemerally —
// never written to config.json. Key values are never logged.
export function discoverProviderKeys(cfg, { authPath } = {}) {
  const out = {};
  if (cfg?.autoDiscover === false) return out;
  for (const [provider, names] of Object.entries(ENV_KEYS)) {
    for (const name of names) {
      const key = process.env[name];
      if (typeof key === 'string' && key.length > 10) {
        (out[provider] ??= []).push({ key, label: name, source: `env:${name}` });
      }
    }
  }
  for (const [rawId, entry] of readAuthEntries(authPath ?? authJsonPath())) {
    const provider = AUTH_MAP[rawId];
    if (!provider) continue;
    (out[provider] ??= []).push({ key: entry.key, label: `auth.json:${rawId}`, source: 'opencode-auth' });
  }
  return out;
}

// Appends discovered keys to config-derived creds, deduped by key value.
// Discovered creds carry `source` so the dashboard can mark them.
export function mergeDiscovered(providerId, cfg, creds) {
  if (cfg?.autoDiscover === false) return creds;
  const seen = new Set(creds.map((c) => c.key));
  const out = [...creds];
  for (const d of discoverProviderKeys(cfg)[providerId] ?? []) {
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    out.push({ provider: providerId, label: d.label, key: d.key, source: d.source });
  }
  return out;
}
