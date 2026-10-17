// @body:organ=muscle type=catalog role="free-model detection, refresh loop, runtime demotion"
import path from 'node:path';
import { ROOT } from './config.mjs';
import { store } from './store.mjs';
import { logger } from './util/log.mjs';
import { registry, byId } from './providers/index.mjs';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_PATH = path.join(ROOT, '.cache', 'models-dev-free.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const state = {
  models: new Map(), // id -> { id, provider, protocol, sources[], addedAt }
  demoted: new Map(), // id -> { reason, at }
  lastRefresh: null,
  refreshOk: false,
  modelsDevOk: false,
  errors: [],
  loop: null,
};

// models.dev pricing: free subset only (tiny), cached via store for 24h.
async function loadFreeTable() {
  try {
    const raw = store.read(CACHE_PATH);
    if (raw) {
      const cached = JSON.parse(raw);
      if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        state.modelsDevOk = true;
        return cached.free;
      }
    }
  } catch { /* corrupt cache — refetch */ }
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const api = await res.json();
    const models = api?.opencode?.models ?? {};
    const free = {};
    for (const [id, m] of Object.entries(models)) {
      if (m?.cost?.input === 0 && m?.cost?.output === 0) free[id] = true;
    }
    try {
      store.write(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), free }));
    } catch { /* best-effort cache — KV limits etc. must not fail the fetch */ }
    state.modelsDevOk = true;
    logger.info('models.dev pricing fetched', { freeCount: Object.keys(free).length });
    return free;
  } catch (err) {
    state.modelsDevOk = false;
    // Stale cache still beats nothing — suffix detection alone would miss stealth models.
    try {
      const raw = store.read(CACHE_PATH);
      if (raw) {
        const stale = JSON.parse(raw);
        logger.warn('models.dev fetch failed, using stale cache', { error: err.message });
        return stale.free;
      }
    } catch { /* fall through */ }
    logger.warn('models.dev unavailable, suffix-only free detection', { error: err.message });
    return null;
  }
}

export async function refresh(cfg) {
  const freeTable = await loadFreeTable();
  // pool: 'all' (default) surfaces every model a keyed provider lists; 'free'
  // keeps the legacy cost/suffix filter. Runtime billing demotion is the
  // safety net either way — a paid model on a free key 402s and drops out.
  const poolMode = cfg?.selection?.pool === 'free' ? 'free' : 'all';
  const blacklisted = new Set(cfg?.selection?.blacklist ?? []);
  const found = new Map();
  const errors = [];
  for (const provider of registry) {
    if (!provider.isEnabled?.(cfg)) continue;
    // A provider with no credential cannot serve anything — skip listing so
    // keyless public routes (openrouter /models) never pollute the pool.
    if ((provider.listCredentials?.(cfg)?.length ?? 0) === 0) continue;
    try {
      const ids = await provider.listModelIds(cfg);
      for (const modelId of ids) {
        if (blacklisted.has(modelId)) continue;
        const sources = provider.freeSources?.(modelId, freeTable) ?? [];
        if (poolMode === 'free' && sources.length === 0) continue;
        if (state.demoted.has(modelId)) continue;
        found.set(modelId, {
          id: modelId,
          provider: provider.id,
          protocol: provider.protocolOf?.(modelId) ?? 'chat',
          sources,
          addedAt: state.models.get(modelId)?.addedAt ?? Date.now(),
        });
      }
    } catch (err) {
      errors.push({ provider: provider.id, error: err.message });
      logger.error('catalog refresh failed for provider', { provider: provider.id, error: err.message });
    }
  }
  if (found.size > 0) {
    state.models = found;
    state.refreshOk = true;
  } else if (errors.length === 0) {
    // No models found and no errors — all providers were skipped (no credentials)
    // or returned empty lists. Clear the catalog rather than keeping stale data.
    state.models = new Map();
    state.refreshOk = true;
  } else {
    // Keep the previous catalog on partial failure — a flaky listing must not empty the pool.
    state.refreshOk = state.models.size > 0;
  }
  state.errors = errors;
  state.lastRefresh = Date.now();
  logger.info('catalog refreshed', {
    pool: poolMode,
    models: state.models.size,
    systemone: [...state.models.values()].filter((m) => m.protocol === 'systemone').length,
    demoted: state.demoted.size,
    modelsDevOk: state.modelsDevOk,
  });
}

// Free-guard: any billing signal removes the model from the pool instantly.
export function demote(modelId, reason) {
  state.demoted.set(modelId, { reason, at: Date.now() });
  state.models.delete(modelId);
  logger.warn('model demoted (runtime)', { modelId, reason });
}

export function reinstate(modelId) {
  state.demoted.delete(modelId);
  logger.info('model demotion cleared (manual)', { modelId });
}

export function getChatModels() {
  return [...state.models.values()].filter((m) => m.protocol === 'chat');
}

export function getModel(modelId) {
  return state.models.get(modelId) ?? null;
}

export function getState() {
  return {
    models: [...state.models.values()],
    demoted: Object.fromEntries(state.demoted),
    lastRefresh: state.lastRefresh,
    refreshOk: state.refreshOk,
    modelsDevOk: state.modelsDevOk,
    errors: state.errors,
  };
}

export function startCatalogLoop(cfg) {
  stopCatalogLoop();
  state.loop = setInterval(() => {
    refresh(cfg).catch((err) => logger.error('catalog loop error', { error: err.message }));
  }, cfg.refresh.catalogMinutes * 60_000);
  if (typeof state.loop.unref === 'function') state.loop.unref();
}

export function stopCatalogLoop() {
  if (state.loop) clearInterval(state.loop);
  state.loop = null;
}

