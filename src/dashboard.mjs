// @body:organ=face type=dashboard role="dashboard API: config CRUD (atomic), keys write-only+masked, catalog refresh, route demote/reinstate, status, SSE events, audit log, hot-apply (Web-standard)"
import path from 'node:path';
import { ROOT, API_KEYS_PATH, saveConfig, maskKey, providerKeyEntries, validateConfig } from './config.mjs';
import { refresh, demote, reinstate, getState as getCatalog, startCatalogLoop } from './catalog.mjs';
import { getRoutesState, runChat } from './routes.mjs';
import { scoreBreakdown } from './strategies/index.mjs';
import { scoringSnapshot, setScoringWeights } from './scoring.mjs';
import { getProbeState, startProbe, stopProbe } from './probe.mjs';
import { byId } from './providers/index.mjs';
import { bus } from './util/events.mjs';
import { securityState } from './security.mjs';
import { jsonRes, errRes, safeEqual, readBodyText } from './util/http.mjs';
import { store } from './store.mjs';
import { logger } from './util/log.mjs';
import { generateApiKey, hashApiKey, publicApiKeys } from './apiKeys.mjs';
import { getUsage, resetUsage } from './usage.mjs';
import { isWorkerRuntime } from './runtime.mjs';
import { hasCompatCredentialsKey } from './compatCredentials.mjs';
import { hasProviderCredentialsKey } from './providerCredentials.mjs';
import { addKeys, removeKey, toggleKey } from './providerKeys.mjs';
import { playgroundChat } from './playground.mjs';
import { testProviders } from './providerTest.mjs';
import {
  probeCompatEndpoint, addCompatInstance, listCompatInstances, toggleCompatInstance, removeCompatInstance,
} from './compatInstances.mjs';

const AUDIT_PATH = path.join(ROOT, 'logs', 'audit.jsonl');
const SSE_INTERVAL_MS = 2000;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_SSE_CLIENTS = 8;
const BOOT_AT = Date.now();
let sseClients = 0;

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function audit(action, detail = {}) {
  try {
    store.append(AUDIT_PATH, `${JSON.stringify({ at: new Date().toISOString(), action, ...detail })}\n`);
  } catch (err) {
    logger.warn('audit write failed', { error: err.message, action });
  }
}

// Newest-first tail of the audit log; the read is capped so a huge file can
// never stall a dashboard request.
function auditTail(limit = 200) {
  const raw = (store.read(AUDIT_PATH) ?? '').slice(-131_072);
  const entries = [];
  for (const line of raw.split('\n').filter(Boolean).slice(-limit).reverse()) {
    try { entries.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return entries;
}

// Dashboard requests use the password; client API keys are separate credentials for /v1.
function isDashboardAuthorized(request, url, password) {
  const header = request.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : request.headers.get('x-api-key') ?? '';
  if (safeEqual(bearer, password)) return true;
  if (url.pathname === '/api/events') return safeEqual(url.searchParams.get('key') ?? '', password);
  return false;
}

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

export function statusSnapshot(cfg) {
  const catalog = getCatalog();
  const routes = getRoutesState();
  const routeStateById = Object.fromEntries(routes.models.map((m) => [m.id, m]));
  const providers = Object.entries(cfg.providers ?? {}).map(([id, p]) => {
    const creds = byId[id]?.listCredentials?.(cfg) ?? [];
    return {
      id,
      enabled: p.enabled === true,
      keys: creds.length,
      discovered: creds.filter((c) => c.source).length,
      configured: providerKeyEntries(p).length,
    };
  });
  const counts = { total: catalog.models.length, ok: 0, unhealthy: 0, successes: 0, failures: 0, requests: 0 };
  const modelsDetail = catalog.models.map((m) => {
    const rs = routeStateById[m.id] ?? { latencyMs: null, ok: 0, fail: 0, consecutiveFails: 0, throttleLevel: 0, throttledUntil: 0, unhealthyUntil: 0, lastUsedAt: 0 };
    if (rs.unhealthyUntil && rs.unhealthyUntil > Date.now()) counts.unhealthy += 1;
    else counts.ok += 1;
    counts.successes += rs.ok ?? 0;
    counts.failures += rs.fail ?? 0;
    counts.requests += (rs.ok ?? 0) + (rs.fail ?? 0);
    const b = scoreBreakdown(m.id, { cfg, states: new Map([[m.id, rs]]), sources: new Map([[m.id, m.sources]]) });
    return {
      ...m,
      ...rs,
      score: Math.round(b.score * 100),
      components: Object.fromEntries(Object.entries(b.components).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      weights: b.weights,
      sources: m.sources,
    };
  });
  const catalogSources = Object.fromEntries(catalog.models.map((m) => [m.id, m.sources]));
  return {
    name: cfg.name,
    runtimePlatform: isWorkerRuntime() ? 'worker' : 'node',
    compatCredentialsReady: !isWorkerRuntime() || hasCompatCredentialsKey(),
    providerKeysReady: !isWorkerRuntime() || hasProviderCredentialsKey(),
    uptimeSec: Math.round((Date.now() - BOOT_AT) / 1000),
    strategy: cfg.selection?.strategy,
    pool: cfg.selection?.pool ?? 'all',
    decision: cfg.decision?.enabled ? cfg.decision.model : 'off',
    models: { free: catalog.models.length, demoted: Object.keys(catalog.demoted).length, lastRefresh: catalog.lastRefresh, refreshOk: catalog.refreshOk },
    routes: counts,
    modelsDetail,
    demoted: catalog.demoted,
    blacklist: cfg.selection?.blacklist ?? [],
    selectionPriorities: cfg.selection?.priorities ?? {},
    providers,
    probe: getProbeState(),
    security: securityState(cfg),
  };
}

// Allowlist patch: everything except secrets. Keys only via /api/keys (write-only).
function hasForbiddenKey(obj) {
  if (obj === null || typeof obj !== 'object') return false;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'apiKey' || k === 'dashboardPassword' || k === 'apiKeys' || k === 'keys') return true;
    if (hasForbiddenKey(v)) return true;
  }
  return false;
}

function loopIntervals(cfg) {
  return { catalog: cfg.refresh?.catalogMinutes, probe: cfg.probe?.intervalMs, warm: cfg.probe?.standbyWarm };
}

function applyConfigPatch(cfg, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return '`body` must be a JSON object';
  if (hasForbiddenKey(patch)) return 'Credential fields cannot be set here — use the dedicated key forms';
  const candidate = structuredClone(cfg);
  for (const field of ['name', 'selection', 'probe', 'refresh', 'decision', 'security', 'stealth', 'persona', 'compaction', 'contextWindows']) {
    if (field in patch) {
      if (patch[field] === null || typeof patch[field] !== 'object') return `\`${field}\` must be an object`;
      candidate[field] = { ...candidate[field], ...patch[field] };
    }
  }
  if ('providers' in patch) {
    if (patch.providers === null || typeof patch.providers !== 'object') return '`providers` must be an object';
    for (const [id, p] of Object.entries(patch.providers)) {
      if (!candidate.providers[id]) return `unknown provider: ${id}`;
      if (p !== null && typeof p === 'object' && 'enabled' in p) candidate.providers[id].enabled = p.enabled === true;
    }
  }
  try {
    validateConfig(candidate);
  } catch (err) {
    return err.message.replace('config invalid: ', '');
  }
  const before = loopIntervals(cfg);
  for (const field of ['name', 'selection', 'probe', 'refresh', 'decision', 'security', 'stealth', 'persona', 'compaction', 'contextWindows']) {
    if (field in patch) cfg[field] = candidate[field];
  }
  if ('providers' in patch) {
    for (const [id, p] of Object.entries(patch.providers)) {
      if (p !== null && typeof p === 'object' && 'enabled' in p) cfg.providers[id].enabled = p.enabled === true;
    }
  }
  saveConfig(cfg);
  const after = loopIntervals(cfg);
  if (after.catalog !== before.catalog) startCatalogLoop(cfg);
  if (after.probe !== before.probe || after.warm !== before.warm) {
    stopProbe();
    startProbe(cfg);
  }
  return null;
}

function clientKeyList(cfg) {
  return publicApiKeys(cfg.apiKeys ?? []);
}

async function createClientKey(cfg, label) {
  const cleanLabel = label.trim().slice(0, 64);
  if (!cleanLabel) return { error: '`name` is required' };
  const key = generateApiKey();
  const record = { id: randomHex(8), label: cleanLabel, hash: await hashApiKey(key), createdAt: new Date().toISOString(), enabled: true };
  cfg.apiKeys = [...(cfg.apiKeys ?? []), record];
  store.write(API_KEYS_PATH, JSON.stringify(cfg.apiKeys));
  return { key, keys: clientKeyList(cfg) };
}

function sseLoop(cfg) {
  if (sseClients >= MAX_SSE_CLIENTS) {
    return errRes(503, 'Too many event streams', 'server_error');
  }
  sseClients += 1;
  const enc = new TextEncoder();
  let closed = false;
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const write = (text) => {
        if (closed) return;
        if (controller.desiredSize !== undefined && controller.desiredSize <= 0) return;
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          if (!closed) { closed = true; cleanup(); }
        }
      };
      const sendEvent = (type, data) => write(`data: ${JSON.stringify({ type, data })}\n\n`);
      const sendSnapshot = () => sendEvent('snapshot', statusSnapshot(cfg));
      const onRoute = (event) => sendEvent('route', event);
      const onProbe = (event) => sendEvent('probe', event);
      const onCompaction = (event) => sendEvent('compaction', event);
      sendSnapshot();
      bus.on('route', onRoute);
      bus.on('probe', onProbe);
      bus.on('compaction', onCompaction);
      const tick = setInterval(sendSnapshot, SSE_INTERVAL_MS);
      const beat = setInterval(() => write(': ping\n\n'), SSE_HEARTBEAT_MS);
      cleanup = () => {
        closed = true;
        clearInterval(tick);
        clearInterval(beat);
        bus.off('route', onRoute);
        bus.off('probe', onProbe);
        bus.off('compaction', onCompaction);
        sseClients -= 1;
      };
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

function handleGet(cfg, url) {
  if (url.pathname === '/api/status') return jsonRes(200, statusSnapshot(cfg));
  if (url.pathname === '/api/config') return jsonRes(200, sanitizeConfig(cfg));
  if (url.pathname === '/api/client-keys') return jsonRes(200, { keys: clientKeyList(cfg) });
  if (url.pathname === '/api/usage') return jsonRes(200, getUsage());
  if (url.pathname === '/api/scoring') return jsonRes(200, scoringSnapshot(cfg));
  if (url.pathname === '/api/audit') return jsonRes(200, { entries: auditTail() });
  if (url.pathname === '/api/openai-compat/instances') {
    return jsonRes(200, { instances: listCompatInstances(cfg) });
  }
  return errRes(404, `Unknown route: GET ${url.pathname}`);
}

async function handlePut(request, cfg, url) {
  if (url.pathname === '/api/keys') {
    let rawK;
    try { rawK = await readBodyText(request, 1024 * 1024); } catch (err) { return errRes(err.status ?? 413, 'Request body too large'); }
    let bodyK;
    try { bodyK = JSON.parse(rawK); } catch {
      return errRes(400, 'Invalid JSON body');
    }
    if (typeof bodyK.provider !== 'string' || !bodyK.provider) return errRes(400, '`provider` required');
    if (typeof bodyK.label !== 'string' || !bodyK.label) return errRes(400, '`label` required');
    if (typeof bodyK.enabled !== 'boolean') return errRes(400, '`enabled` must be boolean');
    const outK = await toggleKey(cfg, bodyK.provider, bodyK.label, bodyK.enabled);
    if (outK.error) return errRes(outK.status ?? 400, outK.error);
    audit('keys.toggle', { provider: bodyK.provider, label: bodyK.label, enabled: bodyK.enabled });
    return jsonRes(200, { provider: bodyK.provider, ...outK });
  }
  if (url.pathname !== '/api/config' && url.pathname !== '/api/openai-compat/instances') return errRes(404, `Unknown route: PUT ${url.pathname}`);
  let raw;
  try { raw = await readBodyText(request, 1024 * 1024); } catch (err) { return errRes(err.status ?? 413, 'Request body too large'); }
  let body;
  try { body = JSON.parse(raw); } catch {
    return errRes(400, 'Invalid JSON body');
  }
  if (url.pathname === '/api/openai-compat/instances') {
    if (typeof body.prefix !== 'string' || !body.prefix) return errRes(400, '`prefix` required');
    if (typeof body.enabled !== 'boolean') return errRes(400, '`enabled` must be boolean');
    const out = await toggleCompatInstance(cfg, body.prefix, body.enabled);
    if (out.error) return errRes(out.status ?? 400, out.error);
    await refresh(cfg);
    audit('openai_compat.toggle', { prefix: body.prefix, enabled: body.enabled });
    return jsonRes(200, { instance: out.instance, status: statusSnapshot(cfg) });
  }
  const beforeBlacklist = JSON.stringify(cfg.selection?.blacklist ?? []);
  const invalid = applyConfigPatch(cfg, body);
  if (invalid) return errRes(400, invalid);
  if (beforeBlacklist !== JSON.stringify(cfg.selection?.blacklist ?? [])) await refresh(cfg);
  audit('config.update', { fields: Object.keys(body) });
  return jsonRes(200, sanitizeConfig(cfg));
}

async function handlePost(request, cfg, url) {
  let raw;
  try { raw = await readBodyText(request, 1024 * 1024); } catch (err) { return errRes(err.status ?? 413, 'Request body too large'); }
  let body;
  try { body = JSON.parse(raw || '{}'); } catch {
    return errRes(400, 'Invalid JSON body');
  }
  if (url.pathname === '/api/playground') return playgroundChat(body, cfg);
  if (url.pathname === '/api/scoring/weights') {
    const out = setScoringWeights(cfg, body.weights);
    if (out.error) return errRes(400, out.error);
    audit('scoring.weights', { weights: out.weights });
    return jsonRes(200, scoringSnapshot(cfg));
  }
  if (url.pathname === '/api/providers/test') {
    const out = await testProviders(cfg, body);
    if (out.error) return errRes(400, out.error);
    audit('providers.test', { results: out.results.map((r) => ({ provider: r.provider, ok: r.ok })) });
    return jsonRes(200, out);
  }
  if (url.pathname === '/api/keys') {
    const out = await addKeys(cfg, body.provider, body.keys);
    if (out.error) return errRes(out.status ?? 400, out.error);
    audit('keys.add', { provider: body.provider, count: out.keys });
    refresh(cfg).catch((err) => logger.error('catalog refresh after key add failed', { error: err.message }));
    return jsonRes(200, { provider: body.provider, keys: (cfg.providers[body.provider].keys ?? []).map((k) => (typeof k === 'string' ? maskKey(k) : maskKey(k.key))) });
  }
  if (url.pathname === '/api/client-keys') {
    const out = await createClientKey(cfg, body.name ?? '');
    if (out.error) return errRes(400, out.error);
    audit('client_keys.create', { label: body.name.trim().slice(0, 64) });
    return jsonRes(201, out);
  }
  if (url.pathname === '/api/openai-compat/instances') {
    const out = await addCompatInstance(cfg, body);
    if (out.error) return errRes(out.status ?? 400, out.error);
    await refresh(cfg);
    audit('openai_compat.add', { name: out.instance.name, prefix: out.instance.prefix });
    return jsonRes(201, { ...out, status: statusSnapshot(cfg) });
  }
  if (url.pathname === '/api/openai-compat/probe') {
    const out = await probeCompatEndpoint(body);
    if (out.error && out.status === undefined) return errRes(400, out.error);
    audit('openai_compat.probe', { ok: out.ok, count: out.count });
    return jsonRes(200, out);
  }
  if (url.pathname === '/api/catalog/refresh') {
    await refresh(cfg);
    audit('catalog.refresh', {});
    return jsonRes(200, statusSnapshot(cfg));
  }
  if (url.pathname === '/api/routes/demote') {
    if (typeof body.modelId !== 'string' || !body.modelId) return errRes(400, '`modelId` required');
    demote(body.modelId, 'manual');
    audit('routes.demote', { modelId: body.modelId });
    return jsonRes(200, statusSnapshot(cfg));
  }
  if (url.pathname === '/api/routes/reinstate') {
    if (typeof body.modelId !== 'string' || !body.modelId) return errRes(400, '`modelId` required');
    reinstate(body.modelId);
    await refresh(cfg);
    audit('routes.reinstate', { modelId: body.modelId });
    return jsonRes(200, statusSnapshot(cfg));
  }
  if (url.pathname === '/api/routes/blacklist') {
    if (typeof body.modelId !== 'string' || !body.modelId) return errRes(400, '`modelId` required');
    cfg.selection.blacklist = [...new Set([...(cfg.selection.blacklist ?? []), body.modelId])];
    saveConfig(cfg);
    demote(body.modelId, 'blacklisted');
    audit('routes.blacklist', { modelId: body.modelId });
    return jsonRes(200, statusSnapshot(cfg));
  }
  if (url.pathname === '/api/routes/unblacklist') {
    if (typeof body.modelId !== 'string' || !body.modelId) return errRes(400, '`modelId` required');
    cfg.selection.blacklist = (cfg.selection.blacklist ?? []).filter((id) => id !== body.modelId);
    saveConfig(cfg);
    reinstate(body.modelId);
    await refresh(cfg);
    audit('routes.unblacklist', { modelId: body.modelId });
    return jsonRes(200, statusSnapshot(cfg));
  }
  if (url.pathname === '/api/models/priority') {
    if (typeof body.modelId !== 'string' || !body.modelId) return errRes(400, '`modelId` required');
    if (typeof body.priority !== 'number' || body.priority < 0 || body.priority > 1) return errRes(400, '`priority` must be between 0 and 1');
    cfg.selection.priorities = { ...(cfg.selection.priorities ?? {}), [body.modelId]: body.priority };
    saveConfig(cfg);
    audit('models.priority', { modelId: body.modelId, priority: body.priority });
    return jsonRes(200, statusSnapshot(cfg));
  }
  if (url.pathname === '/api/usage/reset') {
    resetUsage();
    audit('usage.reset', {});
    return jsonRes(200, getUsage());
  }
  if (url.pathname === '/api/models/try') {
    if (typeof body.modelId !== 'string' || !body.modelId) return errRes(400, '`modelId` required');
    if ((cfg.selection.blacklist ?? []).includes(body.modelId)) return errRes(409, 'Model is blacklisted');
    const started = Date.now();
    const out = await runChat(cfg, { model: body.modelId, messages: [{ role: 'user', content: 'Reply with exactly: model test successful' }], stream: false, max_tokens: 20 }, { keyId: 'dashboard', keyLabel: 'dashboard (try)' });
    if (out.status !== 200) {
      let error;
      try { error = JSON.parse(out.text)?.error?.message; } catch { error = 'Model test failed'; }
      return jsonRes(200, { ok: false, modelId: body.modelId, error: error ?? 'Model test failed', ms: Date.now() - started, attempts: out.attempts ?? [] });
    }
    let preview = '';
    try { preview = JSON.parse(out.text)?.choices?.[0]?.message?.content ?? ''; } catch { /* malformed provider response */ }
    return jsonRes(200, { ok: true, modelId: body.modelId, actualModel: out.route?.model ?? body.modelId, provider: out.route?.provider, ms: Date.now() - started, preview: String(preview).slice(0, 240) });
  }
  return errRes(404, `Unknown route: POST ${url.pathname}`);
}

async function handleDelete(request, cfg, url) {
  if (!['/api/keys', '/api/client-keys', '/api/openai-compat/instances'].includes(url.pathname)) return errRes(404, `Unknown route: DELETE ${url.pathname}`);
  let raw;
  try { raw = await readBodyText(request, 1024 * 1024); } catch (err) { return errRes(err.status ?? 413, 'Request body too large'); }
  let body;
  try { body = JSON.parse(raw || '{}'); } catch {
    return errRes(400, 'Invalid JSON body');
  }
  if (url.pathname === '/api/client-keys') {
    const before = cfg.apiKeys.length;
    cfg.apiKeys = cfg.apiKeys.filter((key) => key.id !== body.id);
    if (cfg.apiKeys.length === before) return errRes(404, 'Unknown client key');
    store.write(API_KEYS_PATH, JSON.stringify(cfg.apiKeys));
    audit('client_keys.revoke', { id: body.id });
    return jsonRes(200, { keys: clientKeyList(cfg) });
  }
  if (url.pathname === '/api/openai-compat/instances') {
    if (typeof body.prefix !== 'string' || !body.prefix) return errRes(400, '`prefix` required');
    const removed = await removeCompatInstance(cfg, body.prefix);
    if (removed.error) return errRes(removed.status ?? 400, removed.error);
    await refresh(cfg);
    audit('openai_compat.remove', { prefix: body.prefix });
    return jsonRes(200, { status: statusSnapshot(cfg) });
  }
  const out = await removeKey(cfg, body.provider, body.label);
  if (out.error) return errRes(out.status ?? 400, out.error);
  audit('keys.remove', { provider: body.provider, label: body.label });
  return jsonRes(200, { provider: body.provider, keys: out.keys });
}

export async function handleDashboard(request, cfg, url) {
  if (url.pathname === '/api/events') {
    if (!isDashboardAuthorized(request, url, cfg.dashboardPassword ?? cfg.apiKey)) return errRes(401, 'Invalid dashboard password');
    return sseLoop(cfg);
  }
  if (!isDashboardAuthorized(request, url, cfg.dashboardPassword ?? cfg.apiKey)) return errRes(401, 'Invalid dashboard password');
  if (request.method === 'GET') return handleGet(cfg, url);
  if (request.method === 'PUT') return handlePut(request, cfg, url);
  if (request.method === 'POST') return handlePost(request, cfg, url);
  if (request.method === 'DELETE') return handleDelete(request, cfg, url);
  return errRes(405, 'Method not allowed');
}
