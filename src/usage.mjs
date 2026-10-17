// @body:organ=muscle type=usage role="usage ledger: per-model / per-client-key / per-provider counters + token counts + 7-day hourly history (requests, latency, failover attempts), persisted through the store seam"
import path from 'node:path';
import { CONFIG_PATH } from './config.mjs';
import { store } from './store.mjs';
import { logger } from './util/log.mjs';

// Sits next to the active config (tmp dirs in tests, KV keys on Workers) so a
// test run can never bleed into a real deployment's ledger.
const USAGE_PATH = path.join(path.dirname(CONFIG_PATH), '.cache', 'usage.json');
const HOUR_MS = 3_600_000;
const RETAIN_HOURS = 24 * 7;
const FLUSH_DEBOUNCE_MS = 5_000;
const MAX_MODELS = 300;
const MAX_KEYS = 200;

const emptyCounters = () => ({ requests: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, msTotal: 0, failover: 0 });

const state = {
  loaded: false,
  dirty: false,
  timer: null,
  models: new Map(), // id -> {provider, requests, ok, fail, tokensIn, tokensOut, msTotal, lastAt}
  keys: new Map(),   // client key id -> {label, requests, ok, fail, lastAt}
  buckets: new Map() // hour ts -> {requests, ok, fail, tokensIn, tokensOut, msTotal, failover}
};

function hourTs(at = Date.now()) {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

function prune(now = Date.now()) {
  const cutoff = hourTs(now) - (RETAIN_HOURS - 1) * HOUR_MS;
  for (const ts of state.buckets.keys()) if (ts < cutoff) state.buckets.delete(ts);
  trimMap(state.models, MAX_MODELS, (e) => e.lastAt ?? 0);
  trimMap(state.keys, MAX_KEYS, (e) => e.lastAt ?? 0);
}

function trimMap(map, cap, score) {
  if (map.size <= cap) return;
  [...map.entries()]
    .sort((a, b) => score(a[1]) - score(b[1]))
    .slice(0, map.size - cap)
    .forEach(([k]) => map.delete(k));
}

function ensureLoaded() {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const raw = store.read(USAGE_PATH);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const [id, e] of Object.entries(saved.models ?? {})) state.models.set(id, e);
    for (const [id, e] of Object.entries(saved.keys ?? {})) state.keys.set(id, e);
    // Ledgers written before P28 lack msTotal/failover — normalize so arithmetic never goes NaN.
    for (const [ts, e] of Object.entries(saved.buckets ?? {})) state.buckets.set(Number(ts), { msTotal: 0, failover: 0, ...e });
    prune();
  } catch (err) {
    logger.warn('usage ledger unreadable, starting fresh', { error: err.message });
  }
}

function serialize() {
  return JSON.stringify({
    models: Object.fromEntries(state.models),
    keys: Object.fromEntries(state.keys),
    buckets: Object.fromEntries(state.buckets),
  });
}

// Debounced persist: writes are cheap but a per-request write would hammer fs/KV.
function scheduleFlush() {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    flush();
  }, FLUSH_DEBOUNCE_MS);
  if (typeof state.timer?.unref === 'function') state.timer.unref();
}

export function flush() {
  if (!state.dirty) return;
  state.dirty = false;
  try {
    store.write(USAGE_PATH, serialize());
  } catch (err) {
    state.dirty = true;
    logger.warn('usage ledger persist failed', { error: err.message });
  }
}

// One upstream attempt = one ledger row. `keyId` attributes the request to a
// client API key (dashboard/internal traffic uses its own id). `attemptIndex`
// (0-based) marks failover retries: index > 0 = a previous model was tried.
export function record(ev) {
  ensureLoaded();
  const at = Date.now();
  const ok = ev.ok === true;
  const tokensIn = Number(ev.tokensIn) || 0;
  const tokensOut = Number(ev.tokensOut) || 0;
  const modelId = String(ev.model ?? 'unknown');

  let model = state.models.get(modelId);
  if (!model) {
    model = { provider: ev.provider ?? 'unknown', requests: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, msTotal: 0, lastAt: 0 };
    state.models.set(modelId, model);
  }
  model.provider = ev.provider ?? model.provider;
  model.requests += 1;
  if (ok) { model.ok += 1; model.msTotal += Number(ev.ms) || 0; } else model.fail += 1;
  model.tokensIn += tokensIn;
  model.tokensOut += tokensOut;
  model.lastAt = at;

  if (ev.keyId) {
    let key = state.keys.get(ev.keyId);
    if (!key) { key = { label: ev.keyLabel ?? ev.keyId, requests: 0, ok: 0, fail: 0, lastAt: 0 }; state.keys.set(ev.keyId, key); }
    if (ev.keyLabel) key.label = ev.keyLabel;
    key.requests += 1;
    if (ok) key.ok += 1; else key.fail += 1;
    key.lastAt = at;
  }

  const ts = hourTs(at);
  let bucket = state.buckets.get(ts);
  if (!bucket) { bucket = emptyCounters(); state.buckets.set(ts, bucket); }
  bucket.requests += 1;
  if (ok) { bucket.ok += 1; bucket.msTotal += Number(ev.ms) || 0; } else bucket.fail += 1;
  bucket.tokensIn += tokensIn;
  bucket.tokensOut += tokensOut;
  if ((Number(ev.attemptIndex) || 0) > 0) bucket.failover += 1;

  state.dirty = true;
  prune(at);
  scheduleFlush();
}

function totals() {
  const out = { requests: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, avgMs: null, successRate: null, failover: 0 };
  let msTotal = 0;
  for (const m of state.models.values()) {
    out.requests += m.requests;
    out.ok += m.ok;
    out.fail += m.fail;
    out.tokensIn += m.tokensIn;
    out.tokensOut += m.tokensOut;
    msTotal += m.msTotal ?? 0;
  }
  for (const b of state.buckets.values()) out.failover += b.failover ?? 0;
  out.avgMs = out.ok > 0 ? Math.round(msTotal / out.ok) : null;
  out.successRate = out.requests > 0 ? out.ok / out.requests : null;
  return out;
}

// Per-provider rollup derived from the model ledger (each model knows its provider).
function providerRollup() {
  const by = new Map();
  for (const m of state.models.values()) {
    let p = by.get(m.provider);
    if (!p) { p = { provider: m.provider, requests: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, msTotal: 0 }; by.set(m.provider, p); }
    p.requests += m.requests;
    p.ok += m.ok;
    p.fail += m.fail;
    p.tokensIn += m.tokensIn;
    p.tokensOut += m.tokensOut;
    p.msTotal += m.msTotal ?? 0;
  }
  return [...by.values()]
    .map((p) => ({
      provider: p.provider,
      requests: p.requests,
      ok: p.ok,
      fail: p.fail,
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
      successRate: p.requests > 0 ? p.ok / p.requests : null,
      avgMs: p.ok > 0 ? Math.round(p.msTotal / p.ok) : null,
    }))
    .sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider));
}

export function getUsage() {
  ensureLoaded();
  const models = [...state.models.entries()]
    .map(([id, m]) => ({
      id,
      provider: m.provider,
      requests: m.requests,
      ok: m.ok,
      fail: m.fail,
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
      avgMs: m.ok > 0 ? Math.round((m.msTotal ?? 0) / m.ok) : null,
      lastAt: m.lastAt,
    }))
    .sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id));
  const keys = [...state.keys.entries()]
    .map(([id, k]) => ({ id, label: k.label, requests: k.requests, ok: k.ok, fail: k.fail, lastAt: k.lastAt }))
    .sort((a, b) => b.requests - a.requests || a.label.localeCompare(b.label));
  const hourly = [...state.buckets.entries()]
    .map(([ts, b]) => ({
      ts,
      ...b,
      successRate: b.requests > 0 ? b.ok / b.requests : null,
      avgMs: b.ok > 0 ? Math.round((b.msTotal ?? 0) / b.ok) : null,
    }))
    .sort((a, b) => a.ts - b.ts);
  return {
    totals: totals(),
    models,
    providers: providerRollup(),
    keys,
    hourly,
    retainHours: RETAIN_HOURS,
    persisted: state.dirty === false,
  };
}

export function resetUsage() {
  state.models.clear();
  state.keys.clear();
  state.buckets.clear();
  state.dirty = true;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  flush();
  logger.info('usage ledger reset');
}
