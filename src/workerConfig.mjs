// @body:organ=brain role="Workers boot: env-binding config assembly + KV-backed store install (testable without cloudflare:workers)"
import { deepMerge, validateConfig, applyEnvKeys, CONFIG_PATH, API_KEYS_PATH, COMPAT_CREDENTIALS_PATH, PROVIDER_CREDENTIALS_PATH } from './config.mjs';
import { setStore } from './store.mjs';
import { configureCompatCredentials, decryptCompatCredentials } from './compatCredentials.mjs';
import { configureProviderCredentials, decryptProviderKeys, hasProviderCredentialsKey } from './providerCredentials.mjs';
import { logger } from './util/log.mjs';
import example from '../config.example.json' with { type: 'json' };

// Shared state that more than one isolate can change. A durable write to any of
// these bumps REV_KEY so other isolates know to re-read (see syncFromKv).
const SHARED_PATHS = [CONFIG_PATH, API_KEYS_PATH, PROVIDER_CREDENTIALS_PATH, COMPAT_CREDENTIALS_PATH];
export const REV_KEY = '__rev';
const pendingWrites = new Set();
let kvCache = null;
let lastRev = null;
let lastSyncAt = 0;

function stripSecrets(cfg) {
  const out = structuredClone(cfg);
  delete out.dashboardPassword;
  delete out.apiKey;
  delete out.apiKeys;
  if (hasProviderCredentialsKey()) {
    for (const p of Object.values(out.providers ?? {})) delete p.keys;
  }
  const compat = out.providers?.['openai-compat'];
  if (compat && hasProviderCredentialsKey()) for (const inst of compat.instances ?? []) delete inst.apiKey;
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

function sanitizeForKv(p, text) {
  if (p !== CONFIG_PATH) return text;
  if (hasProviderCredentialsKey()) return JSON.stringify(stripSecrets(JSON.parse(text)), null, 2);
  // No encryption secret: keep provider keys in the config blob so dashboard
  // management works on the live site (less secure, but functional).
  return text;
}

function newRev() {
  return `${Date.now().toString(36)}-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// Writers coalesce per path: while a put for a path is in flight, newer text
// replaces any queued text, so a burst of audit lines costs two KV writes, not
// one per line (KV free plan = 1,000 writes/day).
export function installKvStore(kv) {
  const cache = new Map();
  const inflight = new Map(); // path -> { queued: text | null }
  kvCache = cache;
  const track = (promise) => {
    pendingWrites.add(promise);
    promise.finally(() => pendingWrites.delete(promise));
    return promise;
  };
  const put = async (p, text) => {
    const slot = inflight.get(p);
    if (slot) { slot.queued = text; return; }
    const state = { queued: null };
    inflight.set(p, state);
    try {
      await kv.put(p, text);
      while (state.queued !== null) {
        const next = state.queued;
        state.queued = null;
        await kv.put(p, next);
      }
    } catch (err) {
      logger.warn('kv put failed', { key: p, error: err.message });
    } finally {
      inflight.delete(p);
    }
  };
  const flush = (p, text) => {
    if (!kv) return;
    let storedText;
    try { storedText = sanitizeForKv(p, text); }
    catch (err) { logger.warn('kv config sanitize failed', { error: err.message }); return; }
    track(put(p, storedText));
  };
  setStore({
    read: (p) => (cache.has(p) ? cache.get(p) : null),
    write: (p, text) => {
      cache.set(p, text);
      flush(p, text);
    },
    // Awaited by dashboard handlers: resolves only once KV has the value, so a
    // "saved" toast is never a lie. Shared paths also bump the revision.
    writeDurable: async (p, text) => {
      if (!kv) throw new Error('KV storage is unavailable');
      await kv.put(p, sanitizeForKv(p, text));
      cache.set(p, text);
      if (SHARED_PATHS.includes(p)) {
        const rev = newRev();
        await kv.put(REV_KEY, rev);
        lastRev = rev;
      }
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

// Resolves once every fire-and-forget KV write started so far has landed.
// worker.mjs hands this to ctx.waitUntil so Cloudflare keeps the isolate alive.
export async function drainPending() {
  for (let i = 0; i < 5 && pendingWrites.size > 0; i += 1) await Promise.allSettled([...pendingWrites]);
}

export function pendingWriteCount() {
  return pendingWrites.size;
}

// Client keys, encrypted provider keys and encrypted custom endpoints all live
// beside the config in KV. Shared by first boot and by syncFromKv.
async function applyStoredSecrets(cfg, cache, env) {
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
}

// What decides which models are in the pool — used to tell the worker whether
// a synced change needs a catalog refresh.
export function poolSignature(cfg) {
  return JSON.stringify([
    cfg.selection?.pool, cfg.selection?.blacklist, cfg.selection?.forceChat,
    Object.entries(cfg.providers ?? {}).map(([id, p]) => [id, p.enabled, (p.keys ?? []).length, (p.instances ?? []).map((i) => [i.prefix, i.enabled])]),
  ]);
}

const LIVE_FIELDS = ['name', 'selection', 'probe', 'refresh', 'decision', 'security', 'stealth', 'persona', 'compaction', 'contextWindows'];

// Cross-isolate consistency. Every isolate keeps its own in-memory config, so a
// change saved through isolate A would otherwise stay invisible to isolate B
// until B happened to restart. This checks one tiny KV key (at most every
// minIntervalMs); only when it changed does it re-read the rest and fold the new
// values into the LIVE cfg object (other modules hold a reference to it).
// KV is eventually consistent, so expect up to ~60s before another edge sees it.
export async function syncFromKv(env, kv, cfg, { now = Date.now(), minIntervalMs = 15_000 } = {}) {
  if (!kv || !kvCache || now - lastSyncAt < minIntervalMs) return { changed: false, poolChanged: false };
  lastSyncAt = now;
  let rev;
  try { rev = await kv.get(REV_KEY); } catch { return { changed: false, poolChanged: false }; }
  if (rev === null || rev === undefined || rev === lastRev) return { changed: false, poolChanged: false };
  const before = poolSignature(cfg);
  try {
    for (const p of SHARED_PATHS) {
      const value = await kv.get(p);
      if (value !== null && value !== undefined) kvCache.set(p, value);
    }
    const fresh = assemble(kvCache.get(CONFIG_PATH), env);
    await applyStoredSecrets(fresh, kvCache, env);
    for (const field of LIVE_FIELDS) if (field in fresh) cfg[field] = fresh[field];
    for (const [id, p] of Object.entries(fresh.providers ?? {})) {
      if (!cfg.providers[id]) { cfg.providers[id] = p; continue; }
      cfg.providers[id].enabled = p.enabled;
      if (id === 'openai-compat') cfg.providers[id].instances = p.instances;
      else cfg.providers[id].keys = p.keys;
    }
    cfg.apiKeys = fresh.apiKeys;
    validateConfig(cfg);
    lastRev = rev;
  } catch (err) {
    logger.warn('config sync from KV failed; keeping the in-memory copy', { error: err.message });
    return { changed: false, poolChanged: false };
  }
  return { changed: true, poolChanged: poolSignature(cfg) !== before };
}

export function resetSyncState() {
  lastRev = null;
  lastSyncAt = 0;
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
  await applyStoredSecrets(cfg, cache, env);
  validateConfig(cfg);
  if (kv) { try { lastRev = await kv.get(REV_KEY); } catch { lastRev = null; } }
  const secretFree = stripSecrets(cfg);
  cache.set(CONFIG_PATH, JSON.stringify(secretFree, null, 2));
  // Seed KV only on the very first boot. Writing at every cold start raced with
  // saves made through another isolate and could roll a setting back.
  if (kv && !saved) Promise.resolve(kv.put(CONFIG_PATH, JSON.stringify(secretFree, null, 2))).catch(() => {});
  return { cfg };
}
