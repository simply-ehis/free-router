// @body:organ=muscle type=test role="P11 stealth: alias-only models list, model-field rewrite (JSON+SSE), content scrub, operator view keeps real ids"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-stealth-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');

const { startServer } = await import('../src/server.mjs');
const { refresh, getChatModels } = await import('../src/catalog.mjs');
const { validateConfig } = await import('../src/config.mjs');
const { resetRateLimiter } = await import('../src/security.mjs');

const ZEN_KEY = 'zen-secret-key-0001';
const CLOUD_KEY = 'cloud-stealth-test-key';
const ALIAS = 'cloud-1';

let mock;
let server;
let base;
let cfg;

function sseOk(model, content, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}

async function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function api(method, pathname, body, stream = false) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, text, json, stream };
}

test('setup: mock zen + server with stealth ON', async () => {
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'echo-free' }, { id: 'paid-model' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        const body = JSON.parse(raw);
        if (body.stream) return sseOk(body.model, `I am ${body.model}, hello`, res);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: `I am ${body.model}, hello` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 },
        }));
      }
      res.writeHead(404); res.end();
    });
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
    security: { rateLimitPerMin: 600, allowedIps: [] },
    stealth: { enabled: true, alias: ALIAS, scrubContent: false },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
  };
  validateConfig(cfg);
  await refresh(cfg);
  resetRateLimiter();
  server = startServer(cfg);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${port}`;
});

test('/v1/models returns ONLY the alias — real ids never on the wire', async () => {
  const { status, text, json } = await api('GET', '/v1/models');
  assert.equal(status, 200);
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].id, ALIAS);
  assert.equal(text.includes('echo-free'), false, 'real id absent from wire');
  assert.ok(getChatModels().some((m) => m.id === 'echo-free'), 'operator catalog still has real id');
});

test('non-stream: model field rewritten to alias; requesting alias routes to free pool', async () => {
  const { status, text, json } = await api('POST', '/v1/chat/completions', {
    model: ALIAS, messages: [{ role: 'user', content: 'hi' }], stream: false,
  });
  assert.equal(status, 200);
  assert.equal(json.model, ALIAS, 'model field is the alias');
  assert.equal(text.includes('"echo-free"'), false, 'real id absent from response body');
});

test('stream: SSE chunk model field rewritten to alias, content intact', async () => {
  const { status, text } = await api('POST', '/v1/chat/completions', {
    model: ALIAS, messages: [{ role: 'user', content: 'hi' }], stream: true,
  });
  assert.equal(status, 200);
  assert.ok(text.includes(`"model":"${ALIAS}"`), 'chunk model rewritten');
  assert.equal(text.includes('"model":"echo-free"'), false, 'model FIELD never real id');
  assert.ok(text.includes('hello'), 'content relayed untouched');
  assert.ok(text.includes('[DONE]'), 'SSE terminator intact');
});

test('scrubContent: assistant text model-id mentions replaced with alias', async () => {
  cfg.stealth.scrubContent = true;
  const { status, text } = await api('POST', '/v1/chat/completions', {
    model: ALIAS, messages: [{ role: 'user', content: 'hi' }], stream: false,
  });
  assert.equal(status, 200);
  assert.equal(text.includes('echo-free'), false, 'real id scrubbed from content');
  assert.ok(text.includes(ALIAS), 'alias present where the id was');
  cfg.stealth.scrubContent = false;
});

test('stealth off: real ids back on the wire', async () => {
  cfg.stealth.enabled = false;
  const { text, json } = await api('GET', '/v1/models');
  assert.ok(json.data.length >= 1, 'real model list restored');
  assert.ok(text.includes('echo-free'), 'real ids visible again');
  const chat = await api('POST', '/v1/chat/completions', {
    model: 'echo-free', messages: [{ role: 'user', content: 'hi' }], stream: false,
  });
  assert.equal(chat.json.model, 'echo-free');
  cfg.stealth.enabled = true;
});

test('config validation rejects bad stealth block', () => {
  assert.throws(() => validateConfig({ ...cfg, stealth: { enabled: 'yes', alias: 'x', scrubContent: false } }), /stealth\.enabled/);
  assert.throws(() => validateConfig({ ...cfg, stealth: { enabled: true, alias: '', scrubContent: false } }), /stealth\.alias/);
});

test('teardown', async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  mock.close();
});
