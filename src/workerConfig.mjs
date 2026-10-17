// @body:organ=brain role="Workers boot: env-binding config assembly + KV-backed store install (testable without cloudflare:workers)"
import { deepMerge, validateConfig, applyEnvKeys, CONFIG_PATH, API_KEYS_PATH, COMPAT_CREDENTIALS_PATH, PROVIDER_CREDENTIALS_PATH } from './config.mjs';
import { setStore } from './store.mjs';
import { configureCompatCredentials, decryptCompatCredentials } from './compatCredentials.mjs';
import { configureProviderCredentials, decryptProviderKeys } from './providerCredentials.mjs';
import { logger } from './util/log.mjs';
import example from '../config.example.json' with { type: 'json' };

function stripSecrets(cfg) {
  const out = structuredClone(cfg);
  delete out.dashboardPassword;
  delete out.apiKey;
  delete out.apiKeys;
  for (const p of Object.values(out.providers ?? {})) delete p.keys;
  const compat = out.providers?.['openai-compat'];
  if (compat) for (const inst of compat.instances ?? []) delete inst.apiKey;
  return out;
}

function assemble(overlayText, env) {
  let base;
  try {
    base = JSON.parse(overlayText ?? '{}');
  } catch (err) {
    throw new Error(`invalid config JSON: ${err.message}`);
  }
  const cfg = deepMerge(structuredClone(example), base);
  cfg.autoDiscover = false;
  if (!cfg.dashboardPassword && typeof cfg.apiKey === 'string') cfg.dashboardPassword = cfg.apiKey;
  delete cfg.apiKey;
  const password = env.DASHBOARD_PASSWORD ?? env.GATEWAY_KEY;
  if (typeof password === 'string' && password.length >= 8) cfg.dashboardPassword = password;
  applyEnvKeys(cfg, env);
  validateConfig(cfg);
  return cfg;
}

// Dashboard password + provider keys come from secret bindings. CONFIG text
// binding carries the non-secret config JSON (selection, security, ...).
export function buildConfig(env) {
  return assemble(env.CONFIG, env);
}

// Sync store over a KV-seeded Map: reads hit memory, writes update memory
// immediately and flush to KV best-effort. A write not yet flushed when the
// isolate is evicted is lost; Node fs impl is durable, Workers impl is
// accepted eventual-loss.
export function installKvStore(kv) {
  const cache = new Map();
  const flush = (p, text) => {
    if (!kv) return;
    let storedText = text;
    if (p === CONFIG_PATH) {
      try { storedText = JSON.stringify(stripSecrets(JSON.parse(text)), null, 2); }
      catch (err) { logger.warn('kv config sanitize failed', { error: err.message }); return; }
    }
    Promise.resolve(kv.put(p, storedText)).catch((err) => { logger.warn('kv put failed', { key: p, error: err.message }); });
  };
  setStore({
    read: (p) => (cache.has(p) ? cache.get(p) : null),
    write: (p, text) => {
      cache.set(p, text);
      flush(p, text);
    },
    writeDurable: async (p, text) => {
      if (!kv) throw new Error('KV storage is unavailable');
      await kv.put(p, text);
      cache.set(p, text);
    },
    append: (p, line) => {
      const next = `${cache.get(p) ?? ''}${line}`;
      const capped = next.length > 512_000 ? next.slice(-256_000) : next;
      cache.set(p, capped);
      flush(p, capped);
    },
  });
  return cache;
}

// Async boot: list+preload KV keys, install store, assemble cfg.
// Exported for tests with a fake kv object ({ list, get, put }).
export async function bootConfig(env, kv) {
  configureCompatCredentials(env.COMPAT_CREDENTIALS_KEY);
  configureProviderCredentials(env.COMPAT_CREDENTIALS_KEY);
  const cache = installKvStore(kv);
  if (kv) {
    try {
      const listed = await kv.list();
      for (const entry of listed.keys ?? []) {
        const value = await kv.get(entry.name);
        if (value !== null && value !== undefined) cache.set(entry.name, value);
      }
    } catch { /* empty namespace or list failure — boot from env */ }
  }
  const saved = cache.get(CONFIG_PATH);
  let cfg;
  if (saved) {
    try {
      cfg = assemble(saved, env);
    } catch {
      cache.delete(CONFIG_PATH);
      cfg = assemble(env.CONFIG, env);
    }
  } else {
    cfg = assemble(env.CONFIG, env);
  }
  try { cfg.apiKeys = JSON.parse(cache.get(API_KEYS_PATH) ?? '[]'); } catch { cfg.apiKeys = []; }
  const compatText = cache.get(COMPAT_CREDENTIALS_PATH);
  if (compatText) {
    const savedCompat = await decryptCompatCredentials(compatText, env.COMPAT_CREDENTIALS_KEY);
    const provider = cfg.providers["openai-compat"];
    provider.instances = savedCompat.instances.map((instance) => ({ ...instance, apiKey: savedCompat.credentials[instance.prefix] }));
    if (provider.instances.length > 0) provider.enabled = true;
  }
  // Dashboard-managed native provider keys live encrypted beside the config;
  // a stored provider's envelope replaces its env-assembled keys so removals
  // and toggles survive eviction. Providers without an envelope entry keep
  // the env-binding keys. Decrypt failure is non-fatal (env keys still work).
  const providerKeysText = cache.get(PROVIDER_CREDENTIALS_PATH);
  if (providerKeysText && env.COMPAT_CREDENTIALS_KEY) {
    try {
      const restored = await decryptProviderKeys(providerKeysText, env.COMPAT_CREDENTIALS_KEY);
      for (const [id, keys] of Object.entries(restored)) {
        if (cfg.providers?.[id]) cfg.providers[id].keys = keys;
      }
    } catch (err) {
      logger.warn('provider key restore failed; falling back to env keys', { error: err.message });
    }
  }
  validateConfig(cfg);
  const secretFree = stripSecrets(cfg);
  cache.set(CONFIG_PATH, JSON.stringify(secretFree, null, 2));
  if (kv) Promise.resolve(kv.put(CONFIG_PATH, JSON.stringify(secretFree, null, 2))).catch(() => {});
  return { cfg };
}
