// @body:organ=muscle type=test role="P17 Cloudflare: Web-standard handleRequest core + worker config/KV boot"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-p17-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');

const { handleRequest } = await import('../src/server.mjs');
const { resetRateLimiter } = await import('../src/security.mjs');
const { buildConfig, bootConfig, installKvStore } = await import('../src/workerConfig.mjs');
const { setStore, resetStore, store } = await import('../src/store.mjs');

const CLOUD_KEY = 'cloud-p17-test-key';

function cfg(over = {}) {
  return {
    name: 'Cloud', apiKey: CLOUD_KEY, host: '127.0.0.1', port: 4141, autoDiscover: false,
    selection: { strategy: 'sticky', pool: 'all', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 5000 },
    providers: {
      zen: { enabled: true, importOpencodeAuth: false, keys: [], baseUrl: '' },
      openrouter: { enabled: true, keys: [], baseUrl: '' },
      groq: { enabled: true, keys: [], baseUrl: '' },
      gemini: { enabled: true, keys: [], baseUrl: '' },
    },
    probe: { intervalMs: 600000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    security: { rateLimitPerMin: 0, allowedIps: [] },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
    ...over,
  };
}

function req(pathname, { method = 'GET', key, headers = {}, body } = {}) {
  const h = { ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return new Request(`http://router.local${pathname}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('handleRequest: /healthz 200 without key', async () => {
  const res = await handleRequest(req('/healthz'), cfg());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('handleRequest: /v1/models 401 without key, 200 with key', async () => {
  const noKey = await handleRequest(req('/v1/models'), cfg());
  assert.equal(noKey.status, 401);
  const withKey = await handleRequest(req('/v1/models', { key: CLOUD_KEY }), cfg());
  assert.equal(withKey.status, 200);
  const body = await withKey.json();
  assert.equal(body.object, 'list');
  assert.ok(Array.isArray(body.data));
});

test('handleRequest: dashboard HTML served with CSP', async () => {
  const res = await handleRequest(req('/'), cfg());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.ok(res.headers.get('content-security-policy'));
  const html = await res.text();
  assert.match(html, /<title>free-router/);
});

test('handleRequest: /api/status 401 without key, 200 with header auth', async () => {
  const noKey = await handleRequest(req('/api/status'), cfg());
  assert.equal(noKey.status, 401);
  const withKey = await handleRequest(req('/api/status', { headers: { 'x-api-key': CLOUD_KEY } }), cfg());
  assert.equal(withKey.status, 200);
  const body = await withKey.json();
  assert.equal(body.name, 'Cloud');
});

test('handleRequest: the password in a ?key= query string is never accepted (it leaks into logs)', async () => {
  const events = await handleRequest(req(`/api/events?key=${CLOUD_KEY}`, { headers: { accept: 'text/event-stream' } }), cfg());
  assert.equal(events.status, 401);
  const status = await handleRequest(req(`/api/status?key=${CLOUD_KEY}`), cfg());
  assert.equal(status.status, 401);
  const viaHeader = await handleRequest(req('/api/events', { headers: { authorization: `Bearer ${CLOUD_KEY}`, accept: 'text/event-stream' } }), cfg());
  assert.equal(viaHeader.status, 200);
  await viaHeader.body?.cancel();
});

test('handleRequest: rate limit 429 after burst, retry-after set', async () => {
  resetRateLimiter();
  const c = cfg({ security: { rateLimitPerMin: 2, allowedIps: [] } });
  const r1 = await handleRequest(req('/v1/models', { key: CLOUD_KEY }), c);
  const r2 = await handleRequest(req('/v1/models', { key: CLOUD_KEY }), c);
  const r3 = await handleRequest(req('/v1/models', { key: CLOUD_KEY }), c);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429);
  assert.ok(Number(r3.headers.get('retry-after')) >= 1);
  resetRateLimiter();
});

test('handleRequest: IP allowlist honors cf-connecting-ip', async () => {
  const c = cfg({ security: { rateLimitPerMin: 0, allowedIps: ['1.2.3.4'] } });
  const blocked = await handleRequest(req('/healthz'), c);
  assert.equal(blocked.status, 403);
  const allowed = await handleRequest(req('/healthz', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), c);
  assert.equal(allowed.status, 200);
});

test('handleRequest: unknown route 404 after auth', async () => {
  const res = await handleRequest(req('/v1/nope', { key: CLOUD_KEY }), cfg());
  assert.equal(res.status, 404);
});

test('handleRequest: chat POST invalid JSON → 400', async () => {
  const res = await new Request('http://router.local/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${CLOUD_KEY}`, 'content-type': 'application/json' },
    body: '{not json',
  });
  const out = await handleRequest(res, cfg());
  assert.equal(out.status, 400);
});

test('buildConfig: gateway key + provider keys from env bindings, autoDiscover forced off', () => {
  const env = {
    GATEWAY_KEY: 'cloud-from-secret-binding',
    FREE_ROUTER_ZEN_KEYS: 'zen-key-one,zen-key-two',
    FREE_ROUTER_OPENROUTER_KEYS: 'or-key-one',
    CONFIG: JSON.stringify({ selection: { pool: 'free' } }),
  };
  const c = buildConfig(env);
  assert.equal(c.dashboardPassword, 'cloud-from-secret-binding');
  assert.deepEqual(c.apiKeys, []);
  assert.equal(c.autoDiscover, false);
  assert.equal(c.selection.pool, 'free');
  assert.deepEqual(c.providers.zen.keys, ['zen-key-one', 'zen-key-two']);
  assert.deepEqual(c.providers.openrouter.keys, ['or-key-one']);
});

test('buildConfig: invalid CONFIG JSON throws', () => {
  assert.throws(() => buildConfig({ CONFIG: '{bad' }));
});

function fakeKv(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async list() { return { keys: [...data.keys()].map((name) => ({ name })) }; },
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async put(k, v) { data.set(k, v); },
  };
}

test('bootConfig: empty KV → boots from env and persists config (secrets stripped)', async () => {
  const kv = fakeKv();
  const env = { GATEWAY_KEY: 'cloud-boot-persist-key', FREE_ROUTER_ZEN_KEYS: 'zk-boot-000001' };
  const { cfg: c } = await bootConfig(env, kv);
  assert.equal(c.dashboardPassword, 'cloud-boot-persist-key');
  assert.deepEqual(c.providers.zen.keys, ['zk-boot-000001']);
  const persisted = [...kv.data.keys()].find((k) => k.endsWith('config.json'));
  assert.ok(persisted, 'config persisted to KV');
  const parsed = JSON.parse(kv.data.get(persisted));
  assert.equal(parsed.dashboardPassword, undefined, 'dashboard password NOT persisted to KV');
  assert.equal(parsed.apiKey, undefined, 'legacy API key NOT persisted to KV');
  assert.equal(parsed.providers.zen.keys, undefined, 'provider keys NOT persisted to KV');
  assert.equal(parsed.name, 'Cloud', 'non-secret config persisted');
});

test('bootConfig: saved KV config wins over defaults, env keys still merged', async () => {
  const first = await bootConfig({ GATEWAY_KEY: 'cloud-first-boot-key-aa' }, fakeKv());
  const kv = fakeKv();
  const { CONFIG_PATH } = await import('../src/config.mjs');
  kv.data.set(CONFIG_PATH, JSON.stringify({ ...JSON.parse(JSON.stringify(first.cfg)), name: 'SavedName', apiKey: 'cloud-saved-key-0001' }));
  const { cfg: c } = await bootConfig({ FREE_ROUTER_GROQ_KEYS: 'gk-from-env-0001' }, kv);
  assert.equal(c.name, 'SavedName');
  assert.equal(c.dashboardPassword, 'cloud-first-boot-key-aa');
  assert.deepEqual(c.providers.groq.keys, ['gk-from-env-0001']);
});

test('bootConfig: corrupt KV config falls back to env bindings', async () => {
  const kv = fakeKv();
  const { CONFIG_PATH } = await import('../src/config.mjs');
  kv.data.set(CONFIG_PATH, '{corrupt json');
  const { cfg: c } = await bootConfig({ GATEWAY_KEY: 'cloud-fallback-key-aa' }, kv);
  assert.equal(c.dashboardPassword, 'cloud-fallback-key-aa');
});

test('installKvStore: read/write/append round-trip; bootConfig preloads KV into cache', async () => {
  const kv = fakeKv({ 'seed.txt': 'hello' });
  // empty cache until bootConfig's preload loop runs
  const cache = installKvStore(kv);
  assert.equal(store.read('seed.txt'), null);
  store.write('out.txt', 'data');
  assert.equal(cache.get('out.txt'), 'data');
  assert.equal(kv.data.get('out.txt'), 'data');
  store.append('log.txt', 'line1\n');
  store.append('log.txt', 'line2\n');
  assert.equal(store.read('log.txt'), 'line1\nline2\n');
  // bootConfig preload: seeded KV key becomes readable synchronously
  const kv2 = fakeKv({ 'seed.txt': 'hello' });
  await bootConfig({ GATEWAY_KEY: 'cloud-preload-key-0001' }, kv2);
  assert.equal(store.read('seed.txt'), 'hello');
  resetStore();
});
