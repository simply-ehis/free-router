// @body:organ=muscle type=test role="streaming failover-before-first-byte + probe revive + standby prewarm"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keeps usage-ledger/config writes out of the repo during the test run.
process.env.FREE_ROUTER_CONFIG = path.join(mkdtempSync(path.join(os.tmpdir(), 'fr-probe-')), 'config.json');

const { validateConfig } = await import('../src/config.mjs');
const { refresh, getState: getCatalog, reinstate } = await import('../src/catalog.mjs');
const { runChat, resetState, healthyCandidates, getRoutesState } = await import('../src/routes.mjs');
const { runOnce: probeOnce, getProbeState } = await import('../src/probe.mjs');

const FREE_IDS = ['alpha-free', 'beta-free', 'gamma-free'];
let mock;
const behavior = { mode: 'ok' };
const requests = [];

function sseBody(model, content) {
  const chunks = [
    { id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  ];
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

async function startMock() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: FREE_IDS.map((id) => ({ id })) }));
        return;
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        const body = JSON.parse(raw);
        requests.push({ model: body.model, stream: body.stream });
        const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
        if (behavior.mode === 'failover' && body.model === 'alpha-free') return json(402, { error: { message: 'insufficient balance' } });
        if (behavior.mode === 'failover' && body.model === 'beta-free') return json(429, { error: { message: 'rate limited' } });
        if (behavior.mode === 'all500') return json(500, { error: { message: 'upstream boom' } });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(sseBody(body.model, `pong from ${body.model}`));
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

function makeCfg(port) {
  const cfg = {
    name: 'test', apiKey: 'cloud-test-key', host: '127.0.0.1', port: 41419, autoDiscover: false,
    selection: { strategy: 'sticky', pool: 'free', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 2000 },
    providers: { zen: { enabled: true, keys: ['zk-1'], importOpencodeAuth: false, baseUrl: `http://127.0.0.1:${port}` } },
    probe: { intervalMs: 12000, standbyWarm: 2 },
    refresh: { catalogMinutes: 10 },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
  };
  validateConfig(cfg);
  return cfg;
}

async function reset(cfg) {
  resetState();
  for (const id of Object.keys(getCatalog().demoted)) reinstate(id);
  await refresh(cfg);
}

test('setup: mock upstream', async () => {
  mock = await startMock();
});

test('stream request relays upstream SSE verbatim after failover', async () => {
  const cfg = makeCfg(mock.port);
  await reset(cfg);
  behavior.mode = 'failover';
  requests.length = 0;
  try {
    const out = await runChat(cfg, { model: 'claude-expensive', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.streaming, true, JSON.stringify(out));
    assert.equal(out.route.model, 'gamma-free', 'alpha/beta failed over before first byte');
    assert.deepEqual(requests.map((r) => r.model), ['alpha-free', 'beta-free', 'gamma-free']);
    assert.ok(requests.every((r) => r.stream === true));
    const text = await new Response(out.upstream.body).text();
    assert.match(text, /pong from gamma-free/);
    assert.match(text, /data: \[DONE\]/);
  } finally { behavior.mode = 'ok'; }
});

test('probe revives unhealthy models and prewarms standbys', async () => {
  const cfg = makeCfg(mock.port);
  await reset(cfg);
  // Push every model past the failure threshold.
  behavior.mode = 'all500';
  for (let i = 0; i < 3; i += 1) await runChat(cfg, { model: 'claude-expensive', messages: [{ role: 'user', content: 'x' }] });
  const unhealthy = getRoutesState().models.filter((m) => m.unhealthyUntil > Date.now());
  assert.equal(unhealthy.length, 3, 'all models should be unhealthy after repeated 500s');
  assert.equal(healthyCandidates().length, 0, 'no healthy candidates while unhealthy');
  const out = await runChat(cfg, { model: 'claude-expensive', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(out.status, 502, 'engine must refuse while pool is unhealthy');

  behavior.mode = 'ok';
  const result = await probeOnce(cfg);
  assert.equal(result.revived, 3, 'probe must revive all unhealthy models');
  assert.equal(healthyCandidates().length, 3, 'pool usable again after probe');
  const state = getProbeState();
  assert.ok(state['alpha-free'].lastOk > 0);
  const warmed = Object.values(state).filter((e) => e.lastWarmAt > 0).length;
  assert.ok(warmed >= 2, `standby prewarm should cover standbyWarm=2 (got ${warmed})`);
});

test('teardown', async () => { if (mock) await mock.close(); });
