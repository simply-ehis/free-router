// @body:organ=muscle role="provider key mutations: add/remove/toggle with encrypted Worker persistence and rollback"
import { saveConfig, providerKeyEntries, enabledKeyEntries, PROVIDER_CREDENTIALS_PATH } from './config.mjs';
import { store } from './store.mjs';
import { logger } from './util/log.mjs';
import { isWorkerRuntime } from './runtime.mjs';
import { hasProviderCredentialsKey, persistProviderKeys } from './providerCredentials.mjs';

function rawKeyIndex(p, label) {
  const m = /^(.+)-(\d+)$/.exec(label ?? '');
  if (!m) return -1;
  const idx = Number(m[2]);
  const entry = p?.keys?.[idx - 1];
  if (!entry) return -1;
  const val = typeof entry === 'string' ? entry : entry?.key;
  return typeof val === 'string' && val.length > 0 ? idx - 1 : -1;
}

// Worker: keys never reach the KV config blob (stripped on flush), so each
// mutation also rewrites the encrypted envelope. Without the encryption key a
// dashboard write would evaporate on isolate eviction — refuse instead of
// pretending it saved. On failure the in-memory mutation is rolled back so the
// running isolate and the durable envelope never diverge.
async function persistWorkerKeys(cfg, provider) {
  if (!isWorkerRuntime()) return null;
  if (!hasProviderCredentialsKey()) {
    return { status: 503, error: 'Cloudflare encrypted credential storage is not configured (set COMPAT_CREDENTIALS_KEY)' };
  }
  try { await persistProviderKeys(cfg, store, PROVIDER_CREDENTIALS_PATH, provider); }
  catch (err) {
    logger.error('encrypted provider key save failed', { provider, error: err.message });
    return { status: 503, error: 'Could not securely save this key to Cloudflare KV' };
  }
  return null;
}

export async function addKeys(cfg, provider, keys) {
  const p = cfg.providers?.[provider];
  if (!p) return { error: `unknown provider: ${provider}` };
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string' && k.trim().length > 0)) {
    return { error: '`keys` must be a non-empty array of non-empty strings' };
  }
  const before = p.keys;
  p.keys = [...new Set([...(p.keys ?? []), ...keys.map((k) => k.trim())])];
  const blocked = await persistWorkerKeys(cfg, provider);
  if (blocked) { p.keys = before; return blocked; }
  saveConfig(cfg);
  return { keys: p.keys.length };
}

export async function removeKey(cfg, provider, label) {
  const p = cfg.providers?.[provider];
  if (!p) return { error: `unknown provider: ${provider}` };
  const rawIdx = rawKeyIndex(p, label);
  if (rawIdx === -1) return { error: `unknown key label: ${label}` };
  const removed = p.keys[rawIdx];
  p.keys.splice(rawIdx, 1);
  const blocked = await persistWorkerKeys(cfg, provider);
  if (blocked) { p.keys.splice(rawIdx, 0, removed); return blocked; }
  saveConfig(cfg);
  return { keys: enabledKeyEntries(p).length };
}

export async function toggleKey(cfg, provider, label, enabled) {
  const p = cfg.providers?.[provider];
  if (!p) return { error: `unknown provider: ${provider}` };
  const rawIdx = rawKeyIndex(p, label);
  if (rawIdx === -1) return { error: `unknown key label: ${label}` };
  const entry = p.keys[rawIdx];
  p.keys[rawIdx] = typeof entry === 'string' ? { key: entry, enabled } : { ...entry, enabled };
  const blocked = await persistWorkerKeys(cfg, provider);
  if (blocked) { p.keys[rawIdx] = entry; return blocked; }
  saveConfig(cfg);
  return { keys: enabledKeyEntries(p).length, total: providerKeyEntries(p).length };
}
