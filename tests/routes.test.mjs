// @body:organ=muscle type=test role="route engine: free-only guard, billing demote, failover, give-up, sticky, aliases/default model"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keeps usage-ledger/config writes out of the repo during the test run.
process.env.FREE_ROUTER_CONFIG = path.join(mkdtempSync(path.join(os.tmpdir(), 'fr-routes-')), 'config.json');

const { validateConfig } = await import('../src/config.mjs');
const { refresh, getState: getCatalog, reinstate } = await import('../src/catalog.mjs');
const { runChat, resetState } = await import('../src/routes.mjs');

const FREE_IDS = ['alpha-free', 'beta-free', 'gamma-free'];

let mock;
const behavior = { mode: 'failover' };
const requests = [];

async function startMock() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        const data = [...FREE_IDS, 'claude-expensive'].map((id) => ({ id, object: 'model' }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data }));
        return;
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        const body = JSON.parse(raw);
        requests.push({ model: body.model, stream: body.stream, tools: (body.tools ?? []).map((t) => t?.function?.name) });
        const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
        const sse = (content, usage) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunks = [
            { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
            { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] },
            { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
          ];
          res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
        };
        if (behavior.mode === 'all500') return json(500, { error: { message: 'upstream boom' } });
        if (behavior.mode === 'failover' && body.model === 'alpha-free') return json(402, { error: { message: 'insufficient balance' } });
        if (behavior.mode === 'failover' && body.model === 'beta-free') return json(429, { error: { message: 'rate limited' } });
        if (behavior.mode === 'deprecated' && body.model === 'alpha-free') {
          return json(410, { type: 'error', error: { type: 'ModelDeprecated', message: 'Model alpha-free has been deprecated.' } });
        }
        if (behavior.mode === 'notsse') return json(200, { id: 'r1', model: body.model, choices: [{ message: { role: 'assistant', content: 'hi' } }] });
        if (behavior.mode === 'toolcalls') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunks = [
            { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: null }] },
            { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
          ];
          return res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
        }
        return sse('hi', { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

function makeCfg(port, over = {}) {
  const cfg = {
    name: 'test', apiKey: 'cloud-test-key', host: '127.0.0.1', port: 41419, autoDiscover: false,
    selection: { strategy: 'sticky', pool: 'free', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 2000 },
    providers: { zen: { enabled: true, keys: ['zk-1'], importOpencodeAuth: false, baseUrl: `http://127.0.0.1:${port}` } },
    probe: { intervalMs: 12000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
    ...over,
  };
  validateConfig(cfg);
  return cfg;
}

async function reset(cfg) {
  resetState();
  for (const id of Object.keys(getCatalog().demoted)) reinstate(id);
  await refresh(cfg);
}

const jevMock = { noul: 0.9, srv: null, url: null, hits: 0 };

async function startJev() {
  jevMock.srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      jevMock.hits += 1;
      const body = JSON.parse(raw);
      const answers = Object.fromEntries(Object.keys(body.questions).map((n) => [n, { type: 'noul', noul: jevMock.noul }]));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, answers, cost: '0' }));
    });
  });
  await new Promise((r) => jevMock.srv.listen(0, '127.0.0.1', r));
  jevMock.url = `http://127.0.0.1:${jevMock.srv.address().port}`;
}

test('setup: catalog keeps free models only', async () => {
  mock = await startMock();
  const cfg = makeCfg(mock.port);
  await refresh(cfg);
  const ids = getCatalog().models.map((m) => m.id).sort();
  assert.deepEqual(ids, [...FREE_IDS].sort());
});

test('paid model request reroutes to free pool; billing model demoted; 429 skipped; success on gamma', async () => {
  const cfg = makeCfg(mock.port);
  await reset(cfg);
  requests.length = 0;
  const out = await runChat(cfg, { model: 'claude-expensive', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.status, 200, JSON.stringify(out));
  const payload = JSON.parse(out.text);
  assert.equal(payload.model, 'gamma-free', 'response.model reports the real route');
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.choices[0].message.content, 'hi', 'SSE assembled into non-stream JSON');
  assert.equal(payload.usage.total_tokens, 6, 'usage carried through assembly');
  assert.ok(requests.every((r) => r.stream === true), 'upstream must always stream (free-tier gate)');
  assert.ok(requests.every((r) => r.tools.includes('bash') && r.tools.includes('read') && r.tools.includes('glob')), 'gate tools injected');
  assert.ok(getCatalog().demoted['alpha-free'], 'billing model must be demoted');
  assert.equal(requests.some((r) => r.model === 'claude-expensive'), false, 'paid model must never hit upstream');
  assert.deepEqual(requests.map((r) => r.model), ['alpha-free', 'beta-free', 'gamma-free']);
});

test('all upstreams failing yields 502 router_error', async () => {
  const cfg = makeCfg(mock.port);
  await reset(cfg);
  behavior.mode = 'all500';
  try {
    const out = await runChat(cfg, { model: 'claude-expensive', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.status, 502);
    const payload = JSON.parse(out.text);
    assert.equal(payload.error.type, 'router_error');
    assert.equal(payload.error.code, 'no_available_model');
  } finally { behavior.mode = 'failover'; }
});

test('sticky: repeated alias resolves to the same free model', async () => {
  const cfg = makeCfg(mock.port);
  await reset(cfg);
  behavior.mode = 'ok';
  try {
    const first = await runChat(cfg, { model: 'claude-cheap', messages: [{ role: 'user', content: 'a' }] });
    const second = await runChat(cfg, { model: 'claude-cheap', messages: [{ role: 'user', content: 'b' }] });
    const m1 = JSON.parse(first.text).model;
    const m2 = JSON.parse(second.text).model;
    assert.equal(m1, m2, 'sticky must hold across requests');
  } finally { behavior.mode = 'failover'; }
});

test('selection alias routes a stable client name to its target model', async () => {
  const cfg = makeCfg(mock.port);
  cfg.selection.aliases = { fast: 'gamma-free' };
  await reset(cfg);
  behavior.mode = 'ok';
  try {
    requests.length = 0;
    const out = await runChat(cfg, { model: 'fast', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.status, 200, JSON.stringify(out));
    assert.equal(JSON.parse(out.text).model, 'gamma-free', 'response.model reports the alias target');
    assert.equal(requests[0].model, 'gamma-free', 'alias target is pinned first upstream');
  } finally { behavior.mode = 'failover'; delete cfg.selection.aliases; }
});

test('unknown model id falls back to selection.defaultModel', async () => {
  const cfg = makeCfg(mock.port);
  cfg.selection.defaultModel = 'gamma-free';
  await reset(cfg);
  behavior.mode = 'ok';
  try {
    const out = await runChat(cfg, { model: 'some-paid-model', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.status, 200, JSON.stringify(out));
    assert.equal(JSON.parse(out.text).model, 'gamma-free', 'default model answers unknown requests');
  } finally { behavior.mode = 'failover'; cfg.selection.defaultModel = ''; }
});

test('alias pointing at a dead id degrades to normal pool order, never errors', async () => {
  const cfg = makeCfg(mock.port);
  cfg.selection.aliases = { ghost: 'no-such-model' };
  await reset(cfg);
  behavior.mode = 'ok';
  try {
    const out = await runChat(cfg, { model: 'ghost', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.status, 200, JSON.stringify(out));
    const served = JSON.parse(out.text).model;
    assert.ok(FREE_IDS.includes(served), `served by a real free model, got ${served}`);
  } finally { behavior.mode = 'failover'; delete cfg.selection.aliases; }
});

test('empty free pool yields 502, never a paid fallback', async () => {
  const cfg = makeCfg(mock.port);
  resetState();
  const orig = mock.srv.listeners('request')[0];
  // swap model list to paid-only
  mock.srv.removeAllListeners('request');
  mock.srv.on('request', (req, res) => {
    if (req.method === 'GET' && req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'claude-expensive', object: 'model' }] }));
      return;
    }
    res.writeHead(500); res.end('must not be called');
  });
  try {
    await refresh(cfg);
    assert.equal(getCatalog().models.length, 0, 'paid-only catalog must be empty');
    const out = await runChat(cfg, { model: 'claude-expensive', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(out.status, 502);
  } finally {
    mock.srv.removeAllListeners('request');
    mock.srv.on('request', orig);
  }
});

test('deprecated model is demoted and traffic fails over', async () => {
  const cfg = makeCfg(mock.port);
  await reset(cfg);
  behavior.mode = 'deprecated';
  requests.length = 0;
  try {
    const out = await runChat(cfg, { model: 'claude-expensive', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.status, 200);
    const payload = JSON.parse(out.text);
    assert.notEqual(payload.model, 'alpha-free');
    assert.ok(getCatalog().demoted['alpha-free'], '410 must demote the model');
    assert.equal(requests[0].model, 'alpha-free');
  } finally { behavior.mode = 'failover'; }
});

test('decision gate wiring: block → 403, flag → marker, allowed/off → untouched', async () => {
  await startJev();
  const decisionBase = { enabled: true, model: 'jev-1.13-free', baseUrl: jevMock.url, classify: false, diagnose: false, rankHints: false, expose: false };
  const body = {
    model: 'claude-cheap',
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }],
  };
  behavior.mode = 'toolcalls';
  try {
    // blocked: low justification confidence → 403 before the client sees tool calls
    jevMock.noul = 0.2;
    const blockCfg = makeCfg(mock.port, { decision: { ...decisionBase, toolVerify: 'block' } });
    await reset(blockCfg);
    const blocked = await runChat(blockCfg, body);
    assert.equal(blocked.status, 403);
    assert.equal(JSON.parse(blocked.text).error.code, 'tool_call_blocked');
    assert.ok(jevMock.hits > 0, 'decision plane must be consulted');

    // allowed: confident justification → tool_calls pass through untouched
    jevMock.noul = 0.9;
    const allowed = await runChat(blockCfg, body);
    assert.equal(allowed.status, 200);
    const allowedPayload = JSON.parse(allowed.text);
    assert.equal(allowedPayload.choices[0].message.tool_calls[0].function.name, 'weather');
    assert.equal(allowedPayload.x_router, undefined);

    // flagged: suspect but mode=flag → rides through with the marker field
    jevMock.noul = 0.2;
    const flagCfg = makeCfg(mock.port, { decision: { ...decisionBase, toolVerify: 'flag' } });
    const flagged = await runChat(flagCfg, body);
    assert.equal(flagged.status, 200);
    const flaggedPayload = JSON.parse(flagged.text);
    assert.equal(flaggedPayload.x_router.tool_verify, 'flagged');
    assert.equal(flaggedPayload.x_router.justified, 0.2);

    // decision plane off → identical passthrough, zero jev consults
    const hitsBefore = jevMock.hits;
    const offCfg = makeCfg(mock.port);
    const untouched = await runChat(offCfg, body);
    assert.equal(untouched.status, 200);
    assert.equal(JSON.parse(untouched.text).x_router, undefined);
    assert.equal(jevMock.hits, hitsBefore, 'disabled plane must never be called');
  } finally {
    behavior.mode = 'failover';
    jevMock.noul = 0.9;
    if (jevMock.srv) await new Promise((r) => jevMock.srv.close(r));
    jevMock.srv = null;
  }
});

test('no configured credentials yields 503 no_credentials', async () => {
  const cfg = makeCfg(mock.port);
  // Zen always carries its anonymous lane credential, so the no-credential
  // path must be exercised through a keyless provider instead.
  cfg.providers.zen.enabled = false;
  await reset(cfg);
  const out = await runChat(cfg, { model: 'claude-expensive', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.status, 503);
  assert.equal(JSON.parse(out.text).error.code, 'no_credentials');
});

test('teardown', async () => { if (mock) await mock.close(); });
