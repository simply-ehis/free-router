// @body:organ=muscle type=test role="jev wire shape, fail-open latch, toolverify gate, /v1/decide endpoint"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateConfig } from '../src/config.mjs';
import { decide, classifyRequest, diagnoseFailure, getDecisionState, resetDecisionState } from '../src/decision.mjs';
import { checkToolCalls } from '../src/middleware/toolverify.mjs';
import smartest from '../src/strategies/smartest.mjs';
import { startServer } from '../src/server.mjs';

const jev = {
  mode: 'ok', // ok | down
  noul: 0.9,
  choice: 'billing',
  lastAuth: null,
  lastBody: null,
  hits: 0,
};

function startJev() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      jev.hits += 1;
      jev.lastAuth = req.headers.authorization ?? null;
      try { jev.lastBody = JSON.parse(raw); } catch { jev.lastBody = null; }
      if (jev.mode === 'down') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"down"}');
      }
      const answers = {};
      for (const [name, spec] of Object.entries(jev.lastBody?.questions ?? {})) {
        answers[name] = spec.type === 'noul' ? { type: 'noul', noul: jev.noul }
          : spec.type === 'choice' ? { type: 'choice', choice: jev.choice, confidence: 0.8, probabilities: {} }
          : { type: 'score', score: 2.5, confidence: 0.9, probabilities: {} };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: jev.lastBody?.model, answers, usage: { input_tokens: 1, output_tokens: 1 }, cost: '0' }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }));
  });
}

function makeCfg(baseUrl, over = {}) {
  const cfg = {
    name: 'test', apiKey: 'cloud-test-key', host: '127.0.0.1', port: over.port ?? 41428,
    selection: { strategy: 'smartest', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 700, attemptTimeoutMs: 2000 },
    providers: {},
    probe: { intervalMs: 12000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    decision: { enabled: true, model: 'jev-1.13-free', baseUrl, classify: true, diagnose: true, rankHints: false, toolVerify: 'off', expose: true, ...over },
  };
  validateConfig(cfg);
  return cfg;
}

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

let mock;

test('setup: mock systemone', async () => {
  mock = await startJev();
  resetDecisionState();
});

test('decide sends the exact keyless wire shape and parses typed answers', async () => {
  const cfg = makeCfg(mock.url);
  const out = await decide(cfg, 'hello world', { ok: { type: 'noul', instructions: 'Is it ok?' } }, { purpose: 'unit' });
  assert.equal(jev.lastAuth, null, 'must NOT send Authorization');
  assert.equal(jev.lastBody.model, 'jev-1.13-free');
  assert.equal(jev.lastBody.state, 'hello world');
  assert.equal(typeof jev.lastBody.questions.ok, 'object', 'questions must be an object map');
  assert.equal(out.answers.ok.noul, 0.9);
  assert.ok(getDecisionState(cfg).recent.some((e) => e.purpose === 'unit' && e.ok));
});

test('classifyRequest returns complexity hints; disabled configs short-circuit', async () => {
  const cfg = makeCfg(mock.url);
  const hints = await classifyRequest(cfg, [{ role: 'user', content: 'write a compiler' }]);
  assert.equal(typeof hints.complexity, 'number');
  const off = makeCfg(mock.url, { enabled: false });
  assert.equal(await classifyRequest(off, [{ role: 'user', content: 'x' }]), null);
  const noClassify = makeCfg(mock.url, { classify: false });
  assert.equal(await classifyRequest(noClassify, [{ role: 'user', content: 'x' }]), null);
});

test('diagnoseFailure maps choice answer to a backoff kind', async () => {
  const cfg = makeCfg(mock.url, { choice: 'billing' });
  const kind = await diagnoseFailure(cfg, { status: 500, kind: 'unknown', text: 'card declined' });
  assert.equal(kind, 'billing');
  jev.choice = 'model_dead';
  assert.equal(await diagnoseFailure(cfg, { status: 404, kind: 'unknown' }), 'notfound');
  jev.choice = 'billing';
});

test('repeated hard failures latch the plane off (fail-open, then self-disable)', async () => {
  const deadCfg = makeCfg('http://127.0.0.1:9'); // connection refused
  resetDecisionState();
  const before = getDecisionState(deadCfg);
  assert.equal(before.disabledUntil, 0);
  for (let i = 0; i < 3; i += 1) {
    const out = await decide(deadCfg, 'x', { q: { type: 'noul', instructions: 'y' } });
    assert.equal(out, null, 'always fail-open to null');
  }
  const latched = getDecisionState(deadCfg);
  assert.ok(latched.disabledUntil > Date.now(), 'plane must self-disable');
  assert.equal(latched.consecutiveFails, 3);
  resetDecisionState();
  assert.equal(getDecisionState(deadCfg).disabledUntil, 0);
});

test('toolverify: flag/block on low justification, fail-open on plane outage', async () => {
  const body = { messages: [{ role: 'user', content: 'delete /tmp' }], tools: [{ type: 'function', function: { name: 'rm' } }] };
  const assembled = { choices: [{ message: { tool_calls: [{ function: { name: 'rm', arguments: '{"path":"/tmp"}' } }] } }] };

  jev.noul = 0.9;
  const blockCfg = makeCfg(mock.url, { toolVerify: 'block' });
  const allowed = await checkToolCalls(blockCfg, body, assembled);
  assert.equal(allowed.action, 'allow');

  jev.noul = 0.2;
  const blocked = await checkToolCalls(blockCfg, body, assembled);
  assert.equal(blocked.action, 'block');
  assert.equal(blocked.prob, 0.2);
  const flagCfg = makeCfg(mock.url, { toolVerify: 'flag' });
  assert.equal((await checkToolCalls(flagCfg, body, assembled)).action, 'flag');

  jev.mode = 'down';
  const outage = await checkToolCalls(blockCfg, body, assembled);
  assert.equal(outage.action, 'allow', 'plane outage must fail open');
  jev.mode = 'ok';

  const offCfg = makeCfg(mock.url, { toolVerify: 'off' });
  assert.equal((await checkToolCalls(offCfg, body, assembled)).action, 'allow');
  const plainResponse = { choices: [{ message: { content: 'hello' } }] };
  assert.equal((await checkToolCalls(blockCfg, body, plainResponse)).action, 'allow', 'responses without tool_calls are never gated');
  jev.noul = 0.9;
});

test('smartest re-weights by decision hints (complex → reliable, trivial → fast)', async () => {
  const cfg = { selection: { weights: { success: 0.4, latency: 0.3 } } };
  const models = [{ id: 'reliable-slow' }, { id: 'flaky-fast' }];
  const states = new Map([
    ['reliable-slow', { ok: 10, fail: 0, latencyMs: 4000 }],
    ['flaky-fast', { ok: 6, fail: 4, latencyMs: 500 }],
  ]);
  const base = { models, cfg, states };
  const plain = await smartest.order(base);
  assert.deepEqual(plain[0], 'flaky-fast', 'neutral baseline prefers the fast model');
  const complex = await smartest.order({ ...base, decisionHints: Promise.resolve({ complexity: 3 }) });
  assert.deepEqual(complex[0], 'reliable-slow', 'complex request must shift weight to reliability');
  const trivial = await smartest.order({ ...base, decisionHints: Promise.resolve({ complexity: 0 }) });
  assert.deepEqual(trivial[0], 'flaky-fast', 'trivial request keeps the speed preference');
  const broken = await smartest.order({ ...base, decisionHints: Promise.reject(new Error('boom')) });
  assert.deepEqual(broken[0], 'flaky-fast', 'rejected hints degrade to baseline, never throw');
});

test('POST /v1/decide: auth, passthrough, validation, outage', async (t) => {
  const cfg = makeCfg(mock.url, { port: await freePort() });
  const server = startServer(cfg);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  t.after(() => { server.closeAllConnections?.(); server.close(); });

  const url = `http://127.0.0.1:${port}/v1/decide`;
  const post = (key, body) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });

  const noKey = await post(null, { state: 'x', questions: { q: { type: 'noul', instructions: 'y' } } });
  assert.equal(noKey.status, 401);

  const bad = await post(cfg.apiKey, { state: 'x', questions: {} });
  assert.equal(bad.status, 400);

  const ok = await post(cfg.apiKey, { state: 'urgent payments failing', questions: { urgent: { type: 'noul', instructions: 'Is it urgent?' } } });
  assert.equal(ok.status, 200);
  const payload = await ok.json();
  assert.equal(payload.answers.urgent.noul, 0.9);
  assert.equal(payload.cost, undefined, 'cost is not forwarded (leak surface)');

  jev.mode = 'down';
  const outage = await post(cfg.apiKey, { state: 'x', questions: { q: { type: 'noul', instructions: 'y' } } });
  assert.equal(outage.status, 502);
  jev.mode = 'ok';

  const hidden = makeCfg(mock.url, { port: await freePort(), expose: false });
  const server2 = startServer(hidden);
  await new Promise((r) => server2.on('listening', r));
  t.after(() => { server2.closeAllConnections?.(); server2.close(); });
  const res2 = await fetch(`http://127.0.0.1:${server2.address().port}/v1/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hidden.apiKey}` },
    body: JSON.stringify({ state: 'x', questions: { q: { type: 'noul', instructions: 'y' } } }),
  });
  assert.equal(res2.status, 404, 'expose:false must hide the endpoint');
});

test('teardown', async () => { if (mock) await mock.close(); });
