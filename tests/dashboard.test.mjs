// @body:organ=muscle type=test role="P7 dashboard: auth, masked config, key add→route appears, hot-apply strategy, SSE live feed, audit log"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-dash-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');

const { startServer } = await import('../src/server.mjs');
const { refresh, getState: getCatalog } = await import('../src/catalog.mjs');
const { validateConfig } = await import('../src/config.mjs');
const { hashApiKey } = await import('../src/apiKeys.mjs');
const { bus } = await import('../src/util/events.mjs');

const ZEN_KEY = 'zen-secret-key-0001';
const GROQ_KEY = 'gq-secret-key-0002';
const DASHBOARD_PASSWORD = 'dashboard-password-test';
const CLIENT_KEY = 'frk-client-test-key-0001';
const CLIENT_KEY_HASH = await hashApiKey(CLIENT_KEY);

let mock;
let server;
let base;
let cfg;

function sseOk(model, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}

async function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function api(method, pathname, body, key = DASHBOARD_PASSWORD) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, text, json };
}

test('setup: mock zen upstream + server boot', async () => {
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'echo-free' }, { id: 'paid-model' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') return sseOk(JSON.parse(raw).model, res);
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = await freePort();
  cfg = {
    name: 'Cloud', dashboardPassword: DASHBOARD_PASSWORD, apiKeys: [{ id: 'fixture', label: 'tests', hash: CLIENT_KEY_HASH, createdAt: '2026-01-01T00:00:00.000Z' }], host: '127.0.0.1', port, autoDiscover: false,
    selection: { strategy: 'sticky', pool: 'free', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 5000 },
    providers: {
      zen: { enabled: true, importOpencodeAuth: false, keys: [ZEN_KEY], baseUrl: `http://127.0.0.1:${mock.address().port}` },
      openrouter: { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.address().port}` },
      groq: { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.address().port}` },
      gemini: { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.address().port}` },
      'openai-compat': { enabled: false, instances: [] },
    },
    probe: { intervalMs: 600000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
  };
  validateConfig(cfg);
  await refresh(cfg);
  server = startServer(cfg);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${port}`;
});

test('dashboard UI served at / (no key needed for HTML)', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /free-router/);
  assert.match(html, /dashboard password/);
  assert.match(html, /Client API keys/);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/, 'CSP allows the external dashboard scripts');
});

test('dashboard css/js assets are served without auth and match their content types', async () => {
  for (const [route, type, marker] of [
    ['/dashboard.css', /text\/css/, '--acc'],
    ['/dashboard.js', /javascript/, 'renderSnapshot'],
    ['/dashboard-models.js', /javascript/, 'renderModels'],
    ['/dashboard-playground.js', /javascript/, 'pgStreamReply'],
    ['/dashboard-providers.js', /javascript/, 'renderProviders'],
    ['/dashboard-security.js', /javascript/, 'renderSecurity'],
    ['/dashboard-analytics.js', /javascript/, 'renderUsage'],
    ['/dashboard-settings.js', /javascript/, 'loadSettings'],
  ]) {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 200, `${route} served`);
    assert.match(res.headers.get('content-type') ?? '', type, `${route} content type`);
    const body = await res.text();
    assert.ok(body.includes(marker), `${route} body has its marker`);
    assert.ok(body.length > 500, `${route} is not truncated`);
  }
  assert.notEqual((await fetch(`${base}/dashboard-unknown.js`)).status, 200, 'unknown asset path is not served');
});

test('auth: /api/* rejects wrong key, accepts right one', async () => {
  const bad = await api('GET', '/api/status', undefined, 'wrong-key');
  assert.equal(bad.status, 401);
  const good = await api('GET', '/api/status');
  assert.equal(good.status, 200);
  assert.equal(good.json.models.free, 1, 'only -free zen model in pool');
});


test('dashboard password and generated client API keys authenticate different surfaces', async () => {
  const created = await api('POST', '/api/client-keys', { name: 'Cline workstation' });
  assert.equal(created.status, 201);
  const key = created.json.key;
  assert.match(key, /^frk_[a-f0-9]{64}$/);
  assert.equal(created.json.keys.find((entry) => entry.label === 'Cline workstation').label, 'Cline workstation');
  assert.equal(JSON.stringify(created.json.keys).includes(key), false, 'key list never returns plaintext');
  assert.equal((await api('GET', '/api/status', undefined, key)).status, 401, 'client key cannot log in to dashboard');
  assert.equal((await api('GET', '/v1/models', undefined, DASHBOARD_PASSWORD)).status, 401, 'dashboard password cannot call model API');
  assert.equal((await api('GET', '/v1/models', undefined, key)).status, 200, 'generated client key calls model API');
  const listed = await api('GET', '/api/client-keys');
  assert.equal(listed.json.keys.length, 2);
  const revoked = await api('DELETE', '/api/client-keys', { id: created.json.keys.find((entry) => entry.label === 'Cline workstation').id });
  assert.equal(revoked.status, 200);
  assert.equal((await api('GET', '/v1/models', undefined, key)).status, 401, 'revoked key stops working');
});

test('custom OpenAI-compatible endpoint asks for name, base URL, and upstream key', async () => {
  cfg.selection.pool = 'all';
  const baseUrl = `http://127.0.0.1:${mock.address().port}`;
  const added = await api('POST', '/api/openai-compat/instances', { name: 'Custom Test', baseUrl, apiKey: 'upstream-custom-secret' });
  assert.equal(added.status, 201);
  assert.equal(added.json.instance.prefix, 'custom-test');
  assert.equal(added.text.includes('upstream-custom-secret'), false);
  const models = await api('GET', '/v1/models', undefined, CLIENT_KEY);
  assert.equal(models.status, 200);
  assert.match(models.text, /custom-test:echo-free/);
  const removed = await api('DELETE', '/api/openai-compat/instances', { prefix: 'custom-test' });
  assert.equal(removed.status, 200);
  cfg.selection.pool = 'free';
  await refresh(cfg);
});

test('status: add a key → route appears (live gate)', async () => {
  const before = await api('GET', '/api/status');
  assert.equal(before.json.models.free, 1, 'only zen -free model until another provider connects');
  assert.equal(before.json.models.free, 1);
  const added = await api('POST', '/api/keys', { provider: 'groq', keys: [GROQ_KEY] });
  assert.equal(added.status, 200);
  assert.equal(added.json.keys.length, 1);
  assert.ok(added.json.keys[0] !== GROQ_KEY, 'response is masked');
  await refresh(JSON.parse(readFileSync(process.env.FREE_ROUTER_CONFIG, 'utf8')));
  const after = await api('GET', '/api/status');
  assert.equal(after.json.providers.find((p) => p.id === 'groq').keys, 1);
  assert.ok(after.json.models.free > before.json.models.free, 'groq free-tier models entered the pool');
});

test('Anthropic Messages endpoint authenticates with x-api-key and translates completions', async () => {
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CLIENT_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'echo-free', max_tokens: 32, system: 'Be brief', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.model, 'echo-free');
  assert.equal(body.content[0].text, 'ok');
});

test('Anthropic Messages endpoint streams Anthropic event frames', async () => {
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CLIENT_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'echo-free', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: content_block_delta/);
  assert.match(text, /event: message_stop/);
});

test('Anthropic model listing uses Anthropic model fields', async () => {
  const res = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + CLIENT_KEY, 'anthropic-version': '2023-06-01' } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data[0].type, 'model');
  assert.equal(body.data[0].lifecycle, 'active');
  assert.equal(body.has_more, false);
  assert.equal(typeof body.data[0].created_at, 'string');
});

test('config GET is masked; raw secrets never leak', async () => {
  const { status, text } = await api('GET', '/api/config');
  assert.equal(status, 200);
  assert.equal(text.includes(ZEN_KEY), false, 'provider key must not appear');
  assert.equal(text.includes(GROQ_KEY), false, 'provider key must not appear');
  assert.equal(text.includes(DASHBOARD_PASSWORD), false, 'dashboard password must not appear');
  assert.equal(text.includes(CLIENT_KEY), false, 'client API key must not appear');
  const cfg = JSON.parse(text);
  assert.equal(cfg.dashboardPassword, undefined);
  assert.equal(cfg.apiKeys, undefined);
  assert.ok(cfg.providers.zen.keys[0] !== ZEN_KEY && cfg.providers.zen.keys[0].length < ZEN_KEY.length);
});

test('config PUT hot-applies strategy and persists atomically', async () => {
  const put = await api('PUT', '/api/config', { selection: { strategy: 'fastest' } });
  assert.equal(put.status, 200);
  assert.equal(put.json.selection.strategy, 'fastest');
  const status = await api('GET', '/api/status');
  assert.equal(status.json.strategy, 'fastest', 'next request reads new strategy (same cfg object)');
  const onDisk = JSON.parse(readFileSync(process.env.FREE_ROUTER_CONFIG, 'utf8'));
  assert.equal(onDisk.selection.strategy, 'fastest');
});

test('config PUT rejects secret fields and unknown providers', async () => {
  const forbidden = await api('PUT', '/api/config', { providers: { zen: { keys: ['sneaky'] } } });
  assert.equal(forbidden.status, 400);
  assert.match(forbidden.json.error.message, /dedicated key forms/);
  const password = await api('PUT', '/api/config', { dashboardPassword: 'other-password' });
  assert.equal(password.status, 400);
  const clientKeys = await api('PUT', '/api/config', { apiKeys: [] });
  assert.equal(clientKeys.status, 400);
  const unknown = await api('PUT', '/api/config', { providers: { nope: { enabled: true } } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error.message, /unknown provider/);
});

test('model viewer reports provider and weighted score', async () => {
  const status = await api('GET', '/api/status');
  const model = status.json.modelsDetail.find((m) => m.id === 'echo-free');
  assert.ok(status.json.providers.some((p) => p.id === model.provider));
  assert.equal(typeof model.score, 'number');
});

test('model priorities accept normalized scores and persist for routing', async () => {
  const out = await api('POST', '/api/models/priority', { modelId: 'echo-free', priority: 1 });
  assert.equal(out.status, 200);
  assert.equal(out.json.selectionPriorities['echo-free'], 1);
  const saved = JSON.parse(readFileSync(process.env.FREE_ROUTER_CONFIG, 'utf8'));
  assert.equal(saved.selection.priorities['echo-free'], 1);
  await api('POST', '/api/models/priority', { modelId: 'echo-free', priority: 0.5 });
});

test('model trial uses the selected route and returns a preview', async () => {
  const out = await api('POST', '/api/models/try', { modelId: 'echo-free' });
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.actualModel, 'echo-free');
  assert.equal(typeof out.json.ms, 'number');
});

test('blacklist persists and unblacklist restores the model', async () => {
  const banned = await api('POST', '/api/routes/blacklist', { modelId: 'echo-free' });
  assert.equal(banned.status, 200);
  assert.ok(banned.json.blacklist.includes('echo-free'));
  assert.equal(banned.json.modelsDetail.some((m) => m.id === 'echo-free'), false);
  const saved = JSON.parse(readFileSync(process.env.FREE_ROUTER_CONFIG, 'utf8'));
  assert.ok(saved.selection.blacklist.includes('echo-free'));
  const restored = await api('POST', '/api/routes/unblacklist', { modelId: 'echo-free' });
  assert.ok(restored.json.modelsDetail.some((m) => m.id === 'echo-free'));
});

test('routes demote/reinstate roundtrip', async () => {
  const demoted = await api('POST', '/api/routes/demote', { modelId: 'echo-free' });
  assert.equal(demoted.status, 200);
  assert.ok(demoted.json.models.demoted >= 1);
  assert.equal(getCatalog().models.some((m) => m.id === 'echo-free'), false);
  const back = await api('POST', '/api/routes/reinstate', { modelId: 'echo-free' });
  assert.equal(back.status, 200);
  await refresh(JSON.parse(readFileSync(process.env.FREE_ROUTER_CONFIG, 'utf8')));
  assert.equal(getCatalog().models.some((m) => m.id === 'echo-free'), true);
});

test('SSE: snapshot on connect + live route events pushed', async () => {
  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${DASHBOARD_PASSWORD}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 5000;
  let sawSnapshot = false;
  let sawRoute = false;
  bus.emit('route', { requested: 'echo-free', model: 'echo-free', provider: 'zen', ok: true, ms: 42, attempts: 1 });
  while (Date.now() < deadline && !(sawSnapshot && sawRoute)) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('sse-timeout')), deadline - Date.now())),
    ]).catch((err) => ({ done: true, err }));
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes('"type":"snapshot"')) sawSnapshot = true;
    if (buffer.includes('"type":"route"')) sawRoute = true;
  }
  reader.cancel().catch(() => {});
  assert.ok(sawSnapshot, 'initial snapshot received');
  assert.ok(sawRoute, 'live route event received');
});

test('custom endpoint toggle: disabled leaves the catalog, enabled restores it', async () => {
  cfg.selection.pool = 'all';
  const baseUrl = `http://127.0.0.1:${mock.address().port}`;
  const added = await api('POST', '/api/openai-compat/instances', { name: 'Toggle Test', baseUrl, apiKey: 'upstream-toggle-secret' });
  assert.equal(added.status, 201);
  await refresh(cfg);
  let models = await api('GET', '/v1/models', undefined, CLIENT_KEY);
  assert.match(models.text, /toggle-test:echo-free/);

  const disabled = await api('PUT', '/api/openai-compat/instances', { prefix: 'toggle-test', enabled: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.instance.enabled, false);
  models = await api('GET', '/v1/models', undefined, CLIENT_KEY);
  assert.equal(/toggle-test:/.test(models.text), false, 'disabled endpoint leaves the catalog');

  const enabled = await api('PUT', '/api/openai-compat/instances', { prefix: 'toggle-test', enabled: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.instance.enabled, true);
  models = await api('GET', '/v1/models', undefined, CLIENT_KEY);
  assert.match(models.text, /toggle-test:echo-free/);

  const unknown = await api('PUT', '/api/openai-compat/instances', { prefix: 'nope', enabled: false });
  assert.equal(unknown.status, 404);
  const removed = await api('DELETE', '/api/openai-compat/instances', { prefix: 'toggle-test' });
  assert.equal(removed.status, 200);
  cfg.selection.pool = 'free';
  await refresh(cfg);
});

test('compat probe verifies an endpoint before it is saved', async () => {
  const baseUrl = `http://127.0.0.1:${mock.address().port}`;
  const probe = await api('POST', '/api/openai-compat/probe', { baseUrl, apiKey: 'probe-secret-value' });
  assert.equal(probe.status, 200);
  assert.equal(probe.json.ok, true);
  assert.ok(probe.json.models.includes('echo-free'), 'probe lists the endpoint models');
  assert.ok(probe.json.count >= 1);
  assert.equal(typeof probe.json.ms, 'number');
  assert.equal(probe.text.includes('probe-secret-value'), false, 'probe key is never echoed back');

  const bad = await api('POST', '/api/openai-compat/probe', { baseUrl: 'ftp://nope.example' });
  assert.equal(bad.status, 400);
  const listed = await api('GET', '/api/openai-compat/instances');
  assert.equal(listed.json.instances.length, 0, 'a probe must not persist anything');
});

test('usage ledger attributes requests to models and client keys', async () => {
  const chat = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_KEY}` },
    body: JSON.stringify({ model: 'echo-free', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(chat.status, 200);
  const usage = await api('GET', '/api/usage');
  assert.equal(usage.status, 200);
  const modelRow = usage.json.models.find((m) => m.id === 'echo-free');
  assert.ok(modelRow, 'served model appears in the ledger');
  assert.ok(modelRow.requests >= 1);
  assert.ok(modelRow.tokensIn > 0 && modelRow.tokensOut > 0, 'upstream token usage captured');
  const keyRow = usage.json.keys.find((k) => k.label === 'tests');
  assert.ok(keyRow, 'client key attribution present by label, never by value');
  assert.equal(usage.text.includes(CLIENT_KEY), false);
  assert.ok(usage.json.hourly.length >= 1, 'hourly history present');
});

test('usage reset returns an empty ledger', async () => {
  const reset = await api('POST', '/api/usage/reset', {});
  assert.equal(reset.status, 200);
  assert.equal(reset.json.totals.requests, 0);
  const after = await api('GET', '/api/usage');
  assert.equal(after.json.totals.requests, 0);
});

test('audit endpoint tails newest entries first and never leaks secrets', async () => {
  const audit = await api('GET', '/api/audit');
  assert.equal(audit.status, 200);
  assert.ok(audit.json.entries.length > 0);
  assert.ok(audit.json.entries.every((e) => typeof e.action === 'string'));
  const times = audit.json.entries.map((e) => e.at);
  assert.deepEqual(times, [...times].sort().reverse(), 'newest first');
  assert.equal(audit.text.includes(ZEN_KEY), false);
  assert.equal(audit.text.includes(DASHBOARD_PASSWORD), false);
});

test('audit log: actions recorded, no raw secrets', async () => {
  const repoAudit = path.join(process.cwd(), 'logs', 'audit.jsonl');
  assert.ok(existsSync(repoAudit), `audit log exists at ${repoAudit}`);
  const content = readFileSync(repoAudit, 'utf8');
  assert.match(content, /"action":"config\.update"/);
  assert.match(content, /"action":"keys\.add"/);
  assert.equal(content.includes(ZEN_KEY), false);
  assert.equal(content.includes(GROQ_KEY), false);
  assert.equal(content.includes(DASHBOARD_PASSWORD), false);
});

test('teardown', async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await new Promise((r) => mock.close(r));
});
