// @body:organ=muscle type=test role="P10 hardening: gateway key rotation, key enable/disable, rate limit 429, security headers, IP allowlist"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-sec-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');

const { startServer } = await import('../src/server.mjs');
const { refresh } = await import('../src/catalog.mjs');
const { validateConfig } = await import('../src/config.mjs');
const { resetRateLimiter } = await import('../src/security.mjs');
const { byId } = await import('../src/providers/index.mjs');

const ZEN_KEY = 'zen-secret-key-0001';
const OR_KEY_A = 'or-secret-key-aaaa';
const OR_KEY_B = 'or-secret-key-bbbb';
const CLOUD_KEY = 'cloud-sec-test-key';

let mock;
let server;
let base;
let cfg;

async function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function api(method, pathname, body, key, headers = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key ?? cfg.apiKey}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, text, json, headers: res.headers };
}

test('setup: mock upstream + server with tight rate limit', async () => {
  mock = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'echo-free' }] }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = await freePort();
  cfg = {
    name: 'Cloud', apiKey: CLOUD_KEY, host: '127.0.0.1', port, autoDiscover: false,
    selection: { strategy: 'sticky', pool: 'free', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 5000 },
    providers: {
      zen: { enabled: true, importOpencodeAuth: false, keys: [ZEN_KEY], baseUrl: `http://127.0.0.1:${mock.address().port}` },
      openrouter: { enabled: true, keys: [], baseUrl: '' },
      groq: { enabled: true, keys: [], baseUrl: '' },
      gemini: { enabled: true, keys: [], baseUrl: '' },
    },
    probe: { intervalMs: 600000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    security: { rateLimitPerMin: 5, allowedIps: [] },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
  };
  validateConfig(cfg);
  await refresh(cfg);
  resetRateLimiter();
  server = startServer(cfg);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${port}`;
});

test('security headers: nosniff + referrer on API, no-store on /api, CSP on HTML', async () => {
  const apiRes = await api('GET', '/v1/models');
  assert.equal(apiRes.status, 200);
  assert.equal(apiRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(apiRes.headers.get('referrer-policy'), 'no-referrer');
  const statusRes = await api('GET', '/api/status');
  assert.equal(statusRes.headers.get('cache-control'), 'no-store');
  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200);
  assert.ok(html.headers.get('content-security-policy')?.includes("default-src 'self'"), 'CSP present on HTML');
  assert.equal(html.headers.get('x-frame-options'), 'DENY');
});

test('rate limit: /v1 hammers return 429 with retry-after once bucket empty', async () => {
  resetRateLimiter();
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await api('GET', '/v1/models'));
  const okCount = results.filter((r) => r.status === 200).length;
  const limited = results.filter((r) => r.status === 429);
  assert.equal(okCount, 5, 'capacity = rateLimitPerMin (5)');
  assert.equal(limited.length, 1);
  assert.ok(Number(limited[0].headers.get('retry-after')) >= 1, 'retry-after set');
  assert.equal(limited[0].json.error.type, 'rate_limit_error');
  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200, 'HTML dashboard exempt from rate limit');
  resetRateLimiter();
});

test('rate limit: security.rateLimitPerMin 0 disables limiting', async () => {
  cfg.security.rateLimitPerMin = 0;
  resetRateLimiter();
  for (let i = 0; i < 10; i++) {
    const r = await api('GET', '/v1/models');
    assert.equal(r.status, 200);
  }
  cfg.security.rateLimitPerMin = 5;
});

test('client API keys are separate, shown once, and revoked independently of dashboard password', async () => {
  resetRateLimiter();
  assert.equal((await api('GET', '/api/status')).status, 200);
  const created = await api('POST', '/api/client-keys', { name: 'security test' });
  assert.equal(created.status, 201);
  const next = created.json.key;
  assert.ok(/^frk_[0-9a-f]{64}$/.test(next));
  assert.equal((await api('GET', '/api/status', undefined, next)).status, 401, 'client key is not the dashboard password');
  assert.equal((await api('GET', '/v1/models', undefined, CLOUD_KEY)).status, 401, 'dashboard password is not an API key');
  assert.equal((await api('GET', '/v1/models', undefined, next)).status, 200, 'client key works for API');
  const auditTail = readFileSync(path.join(process.cwd(), 'logs', 'audit.jsonl'), 'utf8').trim().split('\n').slice(-5).join('\n');
  assert.match(auditTail, /client_keys\.create/);
  assert.equal(auditTail.includes(next), false, 'audit never stores the key value');
  assert.equal((await api('DELETE', '/api/client-keys', { id: created.json.keys[0].id })).status, 200);
  assert.equal((await api('GET', '/v1/models', undefined, next)).status, 401, 'revoked key is rejected');
  delete cfg.apiKeys;
});

test('key toggle: disable by label removes from credential list, enable restores', async () => {
  resetRateLimiter();
  const added = await api('POST', '/api/keys', { provider: 'openrouter', keys: [OR_KEY_A, OR_KEY_B] });
  assert.equal(added.status, 200);
  assert.equal(added.json.keys.length, 2);
  assert.equal(byId.openrouter.listCredentials(cfg).length, 2);
  const disabled = await api('PUT', '/api/keys', { provider: 'openrouter', label: 'or-1', enabled: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.keys, 1, 'one enabled');
  assert.equal(disabled.json.total, 2, 'two total');
  assert.equal(byId.openrouter.listCredentials(cfg).length, 1);
  assert.equal(byId.openrouter.listCredentials(cfg)[0].label, 'or-2', 'stable label survives disable');
  const reenabled = await api('PUT', '/api/keys', { provider: 'openrouter', label: 'or-1', enabled: true });
  assert.equal(reenabled.status, 200);
  assert.equal(byId.openrouter.listCredentials(cfg).length, 2);
  const removed = await api('DELETE', '/api/keys', { provider: 'openrouter', label: 'or-1' });
  assert.equal(removed.status, 200);
  assert.equal(byId.openrouter.listCredentials(cfg).length, 1, 'delete still works on full-index labels');
});

test('IP allowlist: non-empty list blocks localhost, empty restores', async () => {
  resetRateLimiter();
  cfg.security.allowedIps = ['203.0.113.9'];
  const blocked = await api('GET', '/api/status');
  assert.equal(blocked.status, 403);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 403, 'allowlist applies to healthz too');
  cfg.security.allowedIps = [];
  const open = await api('GET', '/api/status');
  assert.equal(open.status, 200);
});

test('teardown', async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  mock.close();
});
