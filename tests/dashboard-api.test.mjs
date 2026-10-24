// @body:organ=face type=test role="dashboard API regressions: settings save (name), pool refresh on change, verify, allow-as-chat, client key pause, sign out everywhere, session probe"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FREE_ROUTER_CONFIG = path.join(mkdtempSync(path.join(os.tmpdir(), 'fr-dapi-')), 'config.json');

const { handleRequest } = await import('../src/server.mjs');
const { validateConfig } = await import('../src/config.mjs');
const { refresh, getState, reinstate } = await import('../src/catalog.mjs');
const { resetState } = await import('../src/routes.mjs');
const { resetRateLimiter } = await import('../src/security.mjs');
const { resetAuthGuard } = await import('../src/authGuard.mjs');
const { resetPingBudget } = await import('../src/freeLanes.mjs');

const PASSWORD = 'dashboard-api-test-password-1';
const CHAT = ['Qwen3-32B', 'gpt-oss-20b', 'Meta-Llama-3_3-70B-Instruct'];
let mock;

function sse(model) {
  const chunks = [
    { id: 'c', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { id: 'c', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return chunks.map((x) => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n';
}

test.before(async () => {
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [...CHAT, 'bge-m3', 'whisper-large-v3'].map((id) => ({ id })) })); }
      if (req.url === '/chat/completions') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(sse(JSON.parse(raw).model)); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
});
test.after(() => new Promise((r) => mock.close(r)));

function makeCfg() {
  const cfg = {
    name: 'Cloud', dashboardPassword: PASSWORD, apiKeys: [], host: '127.0.0.1', port: 4141, autoDiscover: false,
    selection: { strategy: 'sticky', pool: 'all', weights: {}, timeboxMs: 80, attemptTimeoutMs: 3000, forceChat: [], blacklist: [] },
    providers: {
      zen: { enabled: false, keys: [], importOpencodeAuth: false, baseUrl: '' },
      ovh: { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.address().port}` },
    },
    probe: { intervalMs: 600000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    security: { rateLimitPerMin: 0, allowedIps: [], sessionHours: 12, maxLoginFailures: 5 },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
  };
  validateConfig(cfg);
  return cfg;
}

const auth = { authorization: `Bearer ${PASSWORD}` };
function call(cfg, pathname, { method = 'GET', body, headers = auth } = {}) {
  const h = { 'x-local-ip': '203.0.113.5', ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  return handleRequest(new Request(`http://router.local${pathname}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), cfg);
}
const json = async (res) => res.json();

let cfg;
test.beforeEach(async () => {
  resetState(); resetRateLimiter(); resetAuthGuard(); resetPingBudget();
  for (const id of Object.keys(getState().demoted)) reinstate(id);
  cfg = makeCfg();
  await refresh(cfg);
});

test('settings: renaming the router saves (it used to fail with "`name` must be an object", so the whole form never saved)', async () => {
  const res = await call(cfg, '/api/config', { method: 'PUT', body: { name: '  My Router  ', selection: { pool: 'all' } } });
  assert.equal(res.status, 200);
  assert.equal(cfg.name, 'My Router');
  assert.equal((await json(await call(cfg, '/api/config'))).name, 'My Router');
  for (const bad of ['', '   ', 'x'.repeat(65), 7]) {
    const r = await call(cfg, '/api/config', { method: 'PUT', body: { name: bad } });
    assert.equal(r.status, 400, `name ${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal(cfg.name, 'My Router', 'a rejected save changes nothing');
});

test('settings: turning a provider off removes its models immediately, not at the next scheduled refresh', async () => {
  assert.equal(getState().models.length, CHAT.length);
  const res = await call(cfg, '/api/config', { method: 'PUT', body: { providers: { ovh: { enabled: false } } } });
  assert.equal(res.status, 200);
  assert.equal(getState().models.length, 0);
  await call(cfg, '/api/config', { method: 'PUT', body: { providers: { ovh: { enabled: true } } } });
  assert.equal(getState().models.length, CHAT.length);
});

test('status snapshot: every model carries kind + health, and non-chat models are listed with a reason', async () => {
  const snap = await json(await call(cfg, '/api/status'));
  assert.equal(snap.modelsDetail.length, CHAT.length);
  assert.ok(snap.modelsDetail.every((m) => m.kind === 'chat' && m.health === 'untested' && Array.isArray(m.recent)));
  assert.deepEqual(snap.filteredModels.map((f) => f.id).sort(), ['bge-m3', 'whisper-large-v3']);
  assert.equal(snap.models.filtered, 2);
  assert.equal(snap.health.untested, CHAT.length);
  const ovh = snap.providers.find((p) => p.id === 'ovh');
  assert.equal(ovh.lane.keyless, true);
  assert.match(ovh.lane.note, /2 requests\/minute/);
});

test('verify endpoint: tests models, flips them to working, and refuses bad input', async () => {
  const res = await call(cfg, '/api/models/verify', { method: 'POST', body: { ids: ['Qwen3-32B', 'gpt-oss-20b'] } });
  assert.equal(res.status, 200);
  const out = await json(res);
  assert.equal(out.tested, 2);
  assert.ok(out.results.every((r) => r.ok));
  const snap = await json(await call(cfg, '/api/status'));
  assert.equal(snap.health.working, 2);
  assert.equal(snap.health.untested, 1);
  assert.equal((await call(cfg, '/api/models/verify', { method: 'POST', body: {} })).status, 400);
  const byProvider = await json(await call(cfg, '/api/models/verify', { method: 'POST', body: { provider: 'ovh' } }));
  assert.equal(byProvider.tested, CHAT.length);
});

test('allow as chat: a filtered model joins the pool; stop allowing removes it again; the choice is saved in config', async () => {
  let res = await call(cfg, '/api/models/allow', { method: 'POST', body: { modelId: 'bge-m3' } });
  assert.equal(res.status, 200);
  assert.ok(getState().models.some((m) => m.id === 'bge-m3'));
  assert.deepEqual(cfg.selection.forceChat, ['bge-m3']);
  res = await call(cfg, '/api/models/unallow', { method: 'POST', body: { modelId: 'bge-m3' } });
  assert.equal(res.status, 200);
  assert.ok(!getState().models.some((m) => m.id === 'bge-m3'));
  assert.deepEqual(cfg.selection.forceChat, []);
  assert.equal((await call(cfg, '/api/models/allow', { method: 'POST', body: {} })).status, 400);
});

test('client keys: pause blocks the key at once, resume restores it, unknown ids are 404', async () => {
  const created = await json(await call(cfg, '/api/client-keys', { method: 'POST', body: { name: 'cline' } }));
  const bearer = { authorization: `Bearer ${created.key}` };
  assert.equal((await call(cfg, '/v1/models', { headers: bearer })).status, 200);
  const id = created.keys[0].id;
  let res = await call(cfg, '/api/client-keys', { method: 'PUT', body: { id, enabled: false } });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).keys[0].enabled, false);
  assert.equal((await call(cfg, '/v1/models', { headers: bearer })).status, 401);
  await call(cfg, '/api/client-keys', { method: 'PUT', body: { id, enabled: true } });
  assert.equal((await call(cfg, '/v1/models', { headers: bearer })).status, 200);
  assert.equal((await call(cfg, '/api/client-keys', { method: 'PUT', body: { id: 'nope', enabled: true } })).status, 404);
  assert.equal((await call(cfg, '/api/client-keys', { method: 'PUT', body: { id } })).status, 400);
});

test('session probe: answers without a 401, and sign out everywhere kills existing cookies', async () => {
  const anon = await json(await call(cfg, '/api/session', { headers: {} }));
  assert.deepEqual(anon, { authenticated: false });
  const login = await call(cfg, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: {} });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await json(await call(cfg, '/api/session', { headers: { cookie } })), { authenticated: true });
  assert.equal((await call(cfg, '/api/status', { headers: { cookie } })).status, 200);
  const out = await call(cfg, '/api/logout-all', { method: 'POST', body: {}, headers: { cookie } });
  assert.equal(out.status, 200);
  assert.equal(cfg.security.sessionEpoch, 1);
  assert.equal((await call(cfg, '/api/status', { headers: { cookie } })).status, 401, 'the old cookie no longer works');
  assert.deepEqual(await json(await call(cfg, '/api/session', { headers: { cookie } })), { authenticated: false });
});

test('security settings save through the config endpoint and are validated', async () => {
  let res = await call(cfg, '/api/config', { method: 'PUT', body: { security: { rateLimitPerMin: 30, allowedIps: [], sessionHours: 6, maxLoginFailures: 4 } } });
  assert.equal(res.status, 200);
  assert.equal(cfg.security.sessionHours, 6);
  res = await call(cfg, '/api/config', { method: 'PUT', body: { security: { sessionHours: 0 } } });
  assert.equal(res.status, 400);
  assert.equal(cfg.security.sessionHours, 6);
  const status = await json(await call(cfg, '/api/status'));
  assert.ok(status.security.warnings.some((w) => /shorter than 12/.test(w)) === (PASSWORD.length < 12));
});

test('custom endpoints: plain http to a public host and private hosts on a cloud runtime are refused', async () => {
  const { setRuntimePlatform } = await import('../src/runtime.mjs');
  const probe = (baseUrl) => call(cfg, '/api/openai-compat/probe', { method: 'POST', body: { baseUrl } });
  const plain = await probe('http://example.com/v1');
  assert.equal(plain.status, 400);
  assert.match((await json(plain)).error.message, /https/);
  setRuntimePlatform('worker');
  try {
    const priv = await probe('https://192.168.1.10/v1');
    assert.equal(priv.status, 400);
    assert.match((await json(priv)).error.message, /Cloudflare/);
    assert.equal((await probe('https://localhost/v1')).status, 400);
  } finally { setRuntimePlatform('node'); }
});
