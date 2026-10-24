// @body:organ=face type=dashboard role="dashboard read models: masked config + status snapshot (per-model kind/health, key lists, filtered-out models, security warnings)"
import { maskKey, providerKeyEntries } from './config.mjs';
import { getState as getCatalog } from './catalog.mjs';
import { getRoutesState } from './routes.mjs';
import { scoreBreakdown } from './strategies/index.mjs';
import { getProbeState } from './probe.mjs';
import { byId } from './providers/index.mjs';
import { securityState } from './security.mjs';
import { isWorkerRuntime } from './runtime.mjs';
import { hasCompatCredentialsKey } from './compatCredentials.mjs';
import { hasProviderCredentialsKey } from './providerCredentials.mjs';
import { laneInfo, pingsUsed } from './freeLanes.mjs';

const BOOT_AT = Date.now();

export function sanitizeConfig(cfg) {
  const out = structuredClone(cfg);
  delete out.dashboardPassword;
  delete out.apiKey;
  delete out.apiKeys;
  for (const [id, p] of Object.entries(out.providers ?? {})) {
    if (Array.isArray(p.keys)) {
      p.keys = p.keys.map((k) => (typeof k === 'string' ? maskKey(k) : { ...k, key: maskKey(k.key) }));
    }
    if (id === 'openai-compat' && Array.isArray(p.instances)) {
      p.instances = p.instances.map((inst) => ({ ...inst, apiKey: inst.apiKey ? maskKey(inst.apiKey) : undefined }));
    }
  }
  return out;
}

const LIMITED_WINDOW_MS = 10 * 60_000;

// working   — answered successfully (request or check) and nothing failed since
// limited   — the free tier said "slow down" (429) recently; not a failure
// failing   — the latest outcome was a real failure
// cooldown  — benched for a minute after repeated failures
// untested  — listed by the provider, never exercised yet
export function healthOf(routeState, probe, now = Date.now()) {
  if ((routeState.unhealthyUntil ?? 0) > now) return 'cooldown';
  const lastOkAt = Math.max(probe?.lastOk ?? 0, routeState.lastUsedAt ?? 0);
  const lastBadAt = probe?.lastErr?.at ?? 0;
  const limitedAt = Math.max(probe?.lastLimited ?? 0, (routeState.throttledUntil ?? 0) > now ? now : 0);
  if (limitedAt > lastOkAt && limitedAt > lastBadAt && now - limitedAt < LIMITED_WINDOW_MS) return 'limited';
  if (lastOkAt > 0 && lastOkAt >= lastBadAt && (routeState.consecutiveFails ?? 0) === 0) return 'working';
  if (lastBadAt > lastOkAt || (routeState.consecutiveFails ?? 0) > 0) return 'failing';
  return 'untested';
}

function providerRows(cfg) {
  return Object.entries(cfg.providers ?? {}).map(([id, p]) => {
    const creds = byId[id]?.listCredentials?.(cfg) ?? [];
    const keyList = id === 'openai-compat' ? [] : providerKeyEntries(p).map((e) => ({
      label: `${id}-${e.idx}`,
      masked: maskKey(e.key),
      enabled: e.enabled,
    }));
    return {
      id,
      enabled: p.enabled === true,
      keys: creds.length,
      discovered: creds.filter((c) => c.source).length,
      configured: keyList.length,
      keyList,
      autoLanes: creds.filter((c) => c.source).map((c) => ({ label: c.label, source: c.source })),
      lane: { keyless: laneInfo(id).keyless, note: laneInfo(id).note, checksThisHour: pingsUsed(id), checksPerHour: laneInfo(id).pingsPerHour },
    };
  });
}

export function statusSnapshot(cfg) {
  const catalog = getCatalog();
  const routes = getRoutesState();
  const probes = getProbeState();
  const now = Date.now();
  const routeStateById = Object.fromEntries(routes.models.map((m) => [m.id, m]));
  const counts = { total: catalog.models.length, ok: 0, unhealthy: 0, successes: 0, failures: 0, requests: 0 };
  const health = { working: 0, limited: 0, failing: 0, cooldown: 0, untested: 0 };
  const modelsDetail = catalog.models.map((m) => {
    const rs = routeStateById[m.id] ?? { latencyMs: null, ok: 0, fail: 0, consecutiveFails: 0, throttleLevel: 0, throttledUntil: 0, unhealthyUntil: 0, lastUsedAt: 0, recent: [] };
    if (rs.unhealthyUntil && rs.unhealthyUntil > now) counts.unhealthy += 1;
    else counts.ok += 1;
    counts.successes += rs.ok ?? 0;
    counts.failures += rs.fail ?? 0;
    counts.requests += (rs.ok ?? 0) + (rs.fail ?? 0);
    const probe = probes[m.id];
    const status = healthOf(rs, probe, now);
    health[status] += 1;
    const b = scoreBreakdown(m.id, { cfg, states: new Map([[m.id, rs]]), sources: new Map([[m.id, m.sources]]) });
    return {
      ...m,
      ...rs,
      health: status,
      lastOkAt: Math.max(probe?.lastOk ?? 0, rs.lastUsedAt ?? 0) || null,
      lastError: probe?.lastErr ?? null,
      checkMs: probe?.lastMs ?? null,
      score: Math.round(b.score * 100),
      components: Object.fromEntries(Object.entries(b.components).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      weights: b.weights,
      sources: m.sources,
    };
  });
  return {
    name: cfg.name,
    runtimePlatform: isWorkerRuntime() ? 'worker' : 'node',
    compatCredentialsReady: !isWorkerRuntime() || hasCompatCredentialsKey(),
    providerKeysReady: !isWorkerRuntime() || hasProviderCredentialsKey(),
    uptimeSec: Math.round((now - BOOT_AT) / 1000),
    strategy: cfg.selection?.strategy,
    pool: cfg.selection?.pool ?? 'all',
    decision: cfg.decision?.enabled ? cfg.decision.model : 'off',
    models: { free: catalog.models.length, demoted: Object.keys(catalog.demoted).length, filtered: catalog.filtered.length, lastRefresh: catalog.lastRefresh, refreshOk: catalog.refreshOk },
    routes: counts,
    health,
    modelsDetail,
    filteredModels: catalog.filtered,
    demoted: catalog.demoted,
    blacklist: cfg.selection?.blacklist ?? [],
    forceChat: cfg.selection?.forceChat ?? [],
    selectionPriorities: cfg.selection?.priorities ?? {},
    providers: providerRows(cfg),
    catalogErrors: catalog.errors ?? [],
    probe: probes,
    security: securityState(cfg),
  };
}
