// @body:organ=muscle type=test role="P25 playground: auth, validation, non-stream reply + meta, param passthrough, SSE relay, usage attribution, engine error passthrough"
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-pg-'));
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
let lastChatBody = null;

async function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function sseOk(model, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}

async function chat(body, key = DASHBOARD_PASSWORD) {
  const res = await fetch(`${base}/api/playground`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, text, json };
}

test('setup: mock upstream + server boot', async () => {
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'echo-free' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        const body = JSON.parse(raw);
        lastChatBody = body;
        if (Array.isArray(body.messages) && body.messages.some((m) => m.content === 'fail-please')) {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
        }
        return sseOk(body.model, res);
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

test('playground requires the dashboard password', async () => {
  const anon = await fetch(`${base}/api/playground`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(anon.status, 401, 'no bearer → 401');
  const wrong = await chat({ messages: [{ role: 'user', content: 'hi' }] }, 'nope');
  assert.equal(wrong.status, 401, 'wrong password → 401');
});

test('validation: bad payloads are rejected with 400', async () => {
  for (const body of [{}, { messages: [] }, { messages: 'nope' }, { messages: [{ role: 'alien', content: 'hi' }] }, { messages: [{ role: 'user', content: 42 }] }]) {
    const out = await chat(body);
    assert.equal(out.status, 400, JSON.stringify(body));
    assert.ok(out.json?.error?.message, 'error message present');
  }
});

test('non-stream: reply, resolved model meta, tokens, request passthrough', async () => {
  const out = await chat({
    messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }],
    temperature: 0.5,
    maxTokens: 50,
  });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.reply, 'ok', 'upstream reply surfaced');
  assert.equal(out.json.model, 'echo-free', 'auto sentinel resolved to the real model');
  assert.equal(out.json.provider, 'zen');
  assert.ok(out.json.attempts >= 1, 'attempts reported');
  assert.ok(out.json.ms >= 0, 'latency reported');
  assert.equal(out.json.tokensIn, 1, 'upstream usage surfaced');
  assert.equal(out.json.tokensOut, 1);
  assert.equal(lastChatBody.model, 'echo-free', 'upstream saw the real model id');
  assert.equal(lastChatBody.messages[0].role, 'system', 'system message first');
  assert.equal(lastChatBody.temperature, 0.5, 'temperature passed through');
  assert.equal(lastChatBody.max_tokens, 50, 'max_tokens passed through');
});

test('pinned model wins; unknown ids fall back to strategy order', async () => {
  const pinned = await chat({ messages: [{ role: 'user', content: 'hi' }], model: 'echo-free' });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.json.model, 'echo-free');
  const unknown = await chat({ messages: [{ role: 'user', content: 'hi' }], model: 'totally-unknown' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.model, 'echo-free', 'unknown id routes by strategy');
});

test('streaming: SSE relay with route metadata headers', async () => {
  const res = await fetch(`${base}/api/playground`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DASHBOARD_PASSWORD}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(decodeURIComponent(res.headers.get('x-router-model') || ''), 'echo-free');
  assert.equal(res.headers.get('x-router-attempts'), '1');
  const text = await res.text();
  assert.ok(text.includes('data:'), 'SSE data lines relayed');
  assert.ok(text.includes('"content":"ok"'), 'delta content relayed');
  assert.ok(text.includes('[DONE]'), 'stream terminator relayed');
});

test('usage ledger attributes playground traffic', async () => {
  const res = await fetch(`${base}/api/usage`, { headers: { authorization: `Bearer ${DASHBOARD_PASSWORD}` } });
  assert.equal(res.status, 200);
  const usage = await res.json();
  const pg = (usage.keys ?? []).find((k) => k.label === 'playground');
  assert.ok(pg, 'playground row exists in the ledger');
  assert.ok(pg.requests >= 1, 'requests counted');
  assert.ok(pg.ok >= 1, 'successes counted');
});

test('engine failure surfaces as an error with the attempt trail', async () => {
  const out = await chat({ messages: [{ role: 'user', content: 'fail-please' }] });
  assert.equal(out.status, 502);
  assert.match(out.json.error.message, /echo-free/, 'attempt trail names the model');
  assert.ok(out.json.error.attempts.length >= 1, 'attempt list attached');
});
