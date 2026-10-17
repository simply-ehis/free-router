// @body:organ=muscle type=test role="P27 provider key testing: validation, auth, installed/provided key ping, nokey rows, config untouched"
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-ptest-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');

const { startServer } = await import('../src/server.mjs');
const { refresh } = await import('../src/catalog.mjs');
const { validateConfig } = await import('../src/config.mjs');

const GOOD_KEY = 'good-key-0001';
const DASHBOARD_PASSWORD = 'dashboard-password-test';

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

function sseOk(model, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
}

async function api(method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DASHBOARD_PASSWORD}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, text, json };
}

test('setup: auth-enforcing mock upstream + server boot', async () => {
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'echo-free' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        JSON.parse(raw);
        if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        }
        return sseOk('echo-free', res);
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = await freePort();
  cfg = {
    name: 'Cloud', dashboardPassword: DASHBOARD_PASSWORD, apiKeys: [], host: '127.0.0.1', port, autoDiscover: false,
    selection: { strategy: 'sticky', pool: 'free', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 5000 },
    providers: {
      zen: { enabled: true, importOpencodeAuth: false, keys: [GOOD_KEY], baseUrl: `http://127.0.0.1:${mock.address().port}` },
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

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  mock?.close();
});

test('validation: bad payloads are rejected with 400', async () => {
  for (const body of [{ provider: 'bogus' }, { key: '' }, { key: 'x'.repeat(600) }]) {
    const out = await api('POST', '/api/providers/test', body);
    assert.equal(out.status, 400, JSON.stringify(body).slice(0, 40));
    assert.ok(out.json?.error?.message, 'error message present');
  }
});

test('endpoint requires the dashboard password', async () => {
  const res = await fetch(`${base}/api/providers/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 401);
});

test('installed key pings through: ok, masked, model reported', async () => {
  const out = await api('POST', '/api/providers/test', { provider: 'zen' });
  assert.equal(out.status, 200, out.text);
  const r = out.json.results[0];
  assert.equal(r.provider, 'zen');
  assert.equal(r.ok, true, out.text);
  assert.equal(r.model, 'echo-free');
  assert.equal(r.keySource, 'installed');
  assert.ok(r.ms >= 0, 'latency reported');
  assert.ok(r.keyMasked && r.keyMasked !== GOOD_KEY, 'key masked, never echoed raw');
  assert.ok(!r.keyMasked.includes(GOOD_KEY), 'raw key absent from masked form');
});

test('provided candidate key: bad key → ok:false with auth kind, nothing persisted', async () => {
  const out = await api('POST', '/api/providers/test', { provider: 'zen', key: 'bad-key-9999' });
  assert.equal(out.status, 200, out.text);
  const r = out.json.results[0];
  assert.equal(r.ok, false, 'bad key fails');
  assert.equal(r.errorKind, 'auth', 'classified as auth failure');
  assert.match(r.error, /invalid api key/, 'upstream message surfaced');
  assert.equal(r.keySource, 'provided');
  const cfgOut = await api('GET', '/api/config');
  assert.equal(cfgOut.json.providers.zen.keys.length, 1, 'candidate key never persisted');
  assert.ok(!cfgOut.json.providers.zen.keys.includes('bad-key-9999'), 'candidate key absent from config');
  assert.ok(!cfgOut.json.providers.zen.keys.includes(GOOD_KEY), 'keys come back masked, never raw');
});

test('test-all covers every enabled native provider; keyless rows say nokey', async () => {
  const out = await api('POST', '/api/providers/test', {});
  assert.equal(out.status, 200, out.text);
  const byId = Object.fromEntries(out.json.results.map((r) => [r.provider, r]));
  assert.equal(byId.zen?.ok, true, 'zen (has key) passes');
  for (const id of ['openrouter', 'groq', 'gemini']) {
    assert.ok(byId[id], `${id} present in results`);
    assert.equal(byId[id].ok, false);
    assert.equal(byId[id].errorKind, 'nokey', `${id} reports nokey`);
  }
  assert.ok(!byId['openai-compat'], 'compat instances keep their own probe');
});
