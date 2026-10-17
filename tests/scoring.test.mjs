// @body:organ=muscle type=test role="P26 scoring studio: /api/scoring snapshot, weight validation, breakdown math, persistence, status breakdown fields"
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-scor-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');

const { startServer } = await import('../src/server.mjs');
const { refresh } = await import('../src/catalog.mjs');
const { validateConfig } = await import('../src/config.mjs');

const ZEN_KEY = 'zen-secret-key-0001';
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

test('setup: mock upstream + server boot', async () => {
  mock = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'echo-free' }] }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = await freePort();
  cfg = {
    name: 'Cloud', dashboardPassword: DASHBOARD_PASSWORD, apiKeys: [], host: '127.0.0.1', port, autoDiscover: false,
    selection: { strategy: 'smartest', pool: 'free', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 5000 },
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

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  mock?.close();
});

test('GET /api/scoring: weights, defaults, components, per-model breakdown', async () => {
  const out = await api('GET', '/api/scoring');
  assert.equal(out.status, 200);
  assert.equal(out.json.strategy, 'smartest');
  assert.deepEqual(out.json.components, ['success', 'latency', 'freshness', 'priority', 'verified']);
  assert.equal(out.json.defaults.success, 0.4, 'defaults exported');
  for (const c of out.json.components) assert.ok(Number.isFinite(out.json.weights[c]), `effective weight for ${c}`);
  const m = out.json.models.find((x) => x.id === 'echo-free');
  assert.ok(m, 'mock model present');
  assert.ok(Number.isFinite(m.score), 'score numeric');
  for (const c of ['success', 'latency', 'freshness', 'priority', 'verified']) {
    assert.ok(Number.isFinite(m.components[c]), `component ${c} in breakdown`);
    assert.ok(Number.isFinite(m.weights[c]), `used weight ${c} in breakdown`);
  }
});

test('GET /api/status carries components + weights per model (models tab breakdown)', async () => {
  const out = await api('GET', '/api/status');
  assert.equal(out.status, 200);
  const m = out.json.modelsDetail.find((x) => x.id === 'echo-free');
  assert.ok(m.components && typeof m.components.success === 'number', 'components attached');
  assert.ok(m.weights && typeof m.weights.latency === 'number', 'used weights attached');
});

test('POST /api/scoring/weights: validation rejects bad payloads with 400', async () => {
  for (const weights of [undefined, [], 'x', { foo: 1 }, { success: 2 }, { success: -0.1 }, { success: 'high' },
    { success: 0, latency: 0, freshness: 0, priority: 0, verified: 0 }]) {
    const out = await api('POST', '/api/scoring/weights', { weights });
    assert.equal(out.status, 400, JSON.stringify(weights));
    assert.ok(out.json?.error?.message, 'error message present');
  }
});

test('POST /api/scoring/weights: latency-only weights recompute the score (math shared with the strategy)', async () => {
  const out = await api('POST', '/api/scoring/weights', {
    weights: { success: 0, latency: 1, freshness: 0, priority: 0, verified: 0 },
  });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.weights.latency, 1);
  const m = out.json.models.find((x) => x.id === 'echo-free');
  // Unmeasured latency scores 0.3 on the 0-5s scale; with latency as the only
  // nonzero weight the total is exactly that component.
  assert.equal(m.score, 30, 'score = latency component alone');
  assert.equal(m.components.latency, 0.3);
});

test('weights persist through config CRUD and show up on the next snapshot', async () => {
  const cfgOut = await api('GET', '/api/config');
  assert.equal(cfgOut.json.selection.weights.latency, 1, 'persisted to config');
  const snap = await api('GET', '/api/scoring');
  assert.equal(snap.json.weights.latency, 1, 'effective weights reflect the save');
});

test('partial weight updates merge with existing values', async () => {
  const out = await api('POST', '/api/scoring/weights', { weights: { success: 0.5 } });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.weights.success, 0.5, 'updated');
  assert.equal(out.json.weights.latency, 1, 'untouched value survives the merge');
});
