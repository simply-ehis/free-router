// @body:organ=face type=dashboard role="dashboard API: config CRUD (atomic), keys write-only+masked, catalog refresh, route demote/reinstate, status, SSE events, audit log, hot-apply (Web-standard)"
import { API_KEYS_PATH, saveConfigDurable, maskKey, validateConfig } from './config.mjs';
import { refresh, demote, reinstate, startCatalogLoop, getState as getCatalog } from './catalog.mjs';
import { runChat } from './routes.mjs';
import { scoringSnapshot, setScoringWeights } from './scoring.mjs';
import { startProbe, stopProbe, verifyModels } from './probe.mjs';
import { bus } from './util/events.mjs';
import { jsonRes, errRes, readBodyText } from './util/http.mjs';
import { audit, auditTail } from './audit.mjs';
import { sanitizeConfig, statusSnapshot } from './dashboardStatus.mjs';
import { authenticate, handleLogin, handleLogout, handleSessionProbe, sameOriginRequest } from './dashboardAuth.mjs';
import { remoteIp } from './security.mjs';
import { store } from './store.mjs';
import { logger } from './util/log.mjs';
import { generateApiKey, hashApiKey, publicApiKeys } from './apiKeys.mjs';
import { getUsage, resetUsage } from './usage.mjs';
import { addKeys, removeKey, toggleKey } from './providerKeys.mjs';
import { playgroundChat } from './playground.mjs';
import { testProviders } from './providerTest.mjs';
import {
  probeCompatEndpoint, addCompatInstance, listCompatInstances, toggleCompatInstance, removeCompatInstance,
} from './compatInstances.mjs';

const SSE_INTERVAL_MS = 2000;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_SSE_CLIENTS = 8;
let sseClients = 0;

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
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

// Settings that decide pool membership. A change in any of them forces a refresh.
function poolFingerprint(cfg) {
  return JSON.stringify([
    cfg.selection?.pool,
    cfg.selection?.blacklist,
    cfg.selection?.forceChat,
    Object.entries(cfg.providers ?? {}).map(([id, p]) => [id, p.enabled]),
  ]);
}

function loopIntervals(cfg) {
  return { catalog: cfg.refresh?.catalogMinutes, probe: cfg.probe?.intervalMs, warm: cfg.probe?.standbyWarm };
}

async function applyConfigPatch(cfg, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return '`body` must be a JSON object';
  if (hasForbiddenKey(patch)) return 'Credential fields cannot be set here — use the dedicated key forms';
  const candidate = structuredClone(cfg);
  if ('name' in patch) {
    if (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.trim().length > 64) return '`name` must be 1-64 characters';
    candidate.name = patch.name.trim();
  }
  for (const field of ['selection', 'probe', 'refresh', 'decision', 'security', 'stealth', 'persona', 'compaction', 'contextWindows']) {
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
  const poolBefore = poolFingerprint(cfg);
  if ('name' in patch) cfg.name = candidate.name;
  for (const field of ['selection', 'probe', 'refresh', 'decision', 'security', 'stealth', 'persona', 'compaction', 'contextWindows']) {
    if (field in patch) cfg[field] = candidate[field];
  }
  if ('providers' in patch) {
    for (const [id, p] of Object.entries(patch.providers)) {
      if (p !== null && typeof p === 'object' && 'enabled' in p) cfg.providers[id].enabled = p.enabled === true;
    }
  }
  await saveConfigDurable(cfg);
  const after = loopIntervals(cfg);
  if (after.catalog !== before.catalog) startCatalogLoop(cfg);
  if (after.probe !== before.probe || after.warm !== before.warm) {
    stopProbe();
    startProbe(cfg);
  }
  // Anything that changes WHICH models are in the pool takes effect now, not
  // at the next scheduled refresh (that gap made these settings look broken).
  if (poolFingerprint(cfg) !== poolBefore) await refresh(cfg);
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
  await store.writeDurable(API_KEYS_PATH, JSON.stringify(cfg.apiKeys));
  return { key, keys: clientKeyList(cfg) };
}

async function toggleClientKey(request, cfg) {
  let body;
  try { body = JSON.parse(await readBodyText(request, 4096) || '{}'); } catch { return errRes(400, 'Invalid JSON body'); }
  if (typeof body.id !== 'string' || typeof body.enabled !== 'boolean') return errRes(400, '`id` and boolean `enabled` required');
  const record = (cfg.apiKeys ?? []).find((k) => k.id === body.id);
  if (!record) return errRes(404, 'Unknown client key');
  record.enabled = body.enabled;
  await store.writeDurable(API_KEYS_PATH, JSON.stringify(cfg.apiKeys));
  audit(body.enabled ? 'client_keys.enable' : 'client_keys.disable', { id: body.id });
  return jsonRes(200, { keys: clientKeyList(cfg) });
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

// ids: explicit list | provider: every model of one provider | scope 'untested'.
async function verifyEndpoint(cfg, body) {
  const models = getCatalog().models.filter((m) => m.protocol === 'chat');
  let ids;
  if (Array.isArray(body.ids)) ids = body.ids.filter((id) => typeof id === 'string');
  else if (typeof body.provider === 'string') ids = models.filter((m) => m.provider === body.provider).map((m) => m.id);
  else return errRes(400, 'Send `ids` (list) or `provider`');
  const results = await verifyModels(cfg, ids, { max: 12 });
  audit('models.verify', { requested: ids.length, tested: results.length, ok: results.filter((r) => r.ok).length });
  return jsonRes(200, { results, tested: results.length, remaining: Math.max(0, ids.length - results.length) });
}

function handleGet(cfg, url, request) {
  if (url.pathname === '/api/status') return jsonRes(200, statusSnapshot(cfg));
  if (url.pathname === '/api/whoami') return jsonRes(200, { ip: remoteIp(request) });
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
  if (url.pathname === '/api/client-keys') return toggleClientKey(request, cfg);
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
  const invalid = await applyConfigPatch(cfg, body);
  if (invalid) return errRes(400, invalid);
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
    await saveConfigDurable(cfg);
    demote(body.modelId, 'blacklisted');
    audit('routes.blacklist', { modelId: body.modelId });
    return jsonRes(200, statusSnapshot(cfg));
  }
  if (url.pathname === '/api/routes/unblacklist') {
    if (typeof body.modelId !== 'string' || !body.modelId) return errRes(400, '`modelId` required');
    cfg.selection.blacklist = (cfg.selection.blacklist ?? []).filter((id) => id !== body.modelId);
    await saveConfigDurable(cfg);
    reinstate(body.modelId);
    await refresh(cfg);
    audit('routes.unblacklist', { modelId: body.modelId });
    return jsonRes(200, statusSnapshot(cfg));
  }
  if (url.pathname === '/api/models/priority') {
    if (typeof body.modelId !== 'string' || !body.modelId) return errRes(400, '`modelId` required');
    if (typeof body.priority !== 'number' || body.priority < 0 || body.priority > 1) return errRes(400, '`priority` must be between 0 and 1');
    cfg.selection.priorities = { ...(cfg.selection.priorities ?? {}), [body.modelId]: body.priority };
    await saveConfigDurable(cfg);
    audit('models.priority', { modelId: body.modelId, priority: body.priority });
    return jsonRes(200, statusSnapshot(cfg));
  }
  if (url.pathname === '/api/models/verify') return verifyEndpoint(cfg, body);
  if (url.pathname === '/api/models/allow' || url.pathname === '/api/models/unallow') {
    if (typeof body.modelId !== 'string' || !body.modelId) return errRes(400, '`modelId` required');
    const allow = url.pathname.endsWith('/allow');
    const current = cfg.selection.forceChat ?? [];
    cfg.selection.forceChat = allow ? [...new Set([...current, body.modelId])] : current.filter((id) => id !== body.modelId);
    await saveConfigDurable(cfg);
    await refresh(cfg);
    audit(allow ? 'models.allow_chat' : 'models.unallow_chat', { modelId: body.modelId });
    return jsonRes(200, statusSnapshot(cfg));
  }
  if (url.pathname === '/api/logout-all') {
    cfg.security.sessionEpoch = (cfg.security.sessionEpoch ?? 0) + 1;
    await saveConfigDurable(cfg);
    audit('auth.logout_all', {});
    return handleLogout(url);
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
    await store.writeDurable(API_KEYS_PATH, JSON.stringify(cfg.apiKeys));
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
  if (url.pathname === '/api/session' && request.method === 'GET') return handleSessionProbe(request, cfg);
  if (url.pathname === '/api/login' && request.method === 'POST') return handleLogin(request, cfg, url);
  if (url.pathname === '/api/logout' && request.method === 'POST') return handleLogout(url);
  const auth = await authenticate(request, cfg);
  if (!auth.ok) return auth.response;
  const mutating = request.method !== 'GET' && request.method !== 'HEAD';
  if (auth.via === 'cookie' && mutating && !sameOriginRequest(request, url)) return errRes(403, 'Cross-site request blocked');
  if (url.pathname === '/api/events') return sseLoop(cfg);
  if (request.method === 'GET') return handleGet(cfg, url, request);
  if (request.method === 'PUT') return handlePut(request, cfg, url);
  if (request.method === 'POST') return handlePost(request, cfg, url);
  if (request.method === 'DELETE') return handleDelete(request, cfg, url);
  return errRes(405, 'Method not allowed');
}
