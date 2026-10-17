// @body:organ=muscle type=test role="P13 context: token estimate, window override, truncate-oldest, summarize w/ fail-open, x_router marker"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-ctx-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');

const { contextWindowOf, estimateTokens, truncateOldest, splitForSummarize, FALLBACK_WINDOW } = await import('../src/context.mjs');
const { validateConfig } = await import('../src/config.mjs');

test('estimateTokens: chars/4, content parts counted', () => {
  assert.equal(estimateTokens([{ role: 'user', content: 'a'.repeat(400) }]), 100);
  assert.equal(estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'b'.repeat(400) }] }]), 100);
});

test('contextWindowOf: override > fallback', () => {
  assert.equal(contextWindowOf({}, 'any'), FALLBACK_WINDOW);
  assert.equal(contextWindowOf({ contextWindows: { any: 2048 } }, 'any'), 2048);
  assert.equal(contextWindowOf({ contextWindows: { any: 100 } }, 'any'), FALLBACK_WINDOW, 'sub-256 override ignored');
});

test('truncateOldest: keeps system + newest, never drops last message', () => {
  const messages = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'u1 '.repeat(500) },
    { role: 'assistant', content: 'a1 '.repeat(500) },
    { role: 'user', content: 'u2 '.repeat(500) },
    { role: 'user', content: 'current-question' },
  ];
  const out = truncateOldest(messages, 700);
  assert.ok(out.dropped >= 2, `dropped some old turns, got ${out.dropped}`);
  assert.equal(out.messages.at(-1).content, 'current-question', 'current user turn preserved');
  assert.equal(out.messages[0].role, 'system', 'system preserved');
  assert.equal(estimateTokens(out.messages) <= 700 + 64, true, 'fits budget (+headroom slack)');
});

test('truncateOldest: no-op when everything fits', () => {
  const messages = [{ role: 'user', content: 'tiny' }];
  const out = truncateOldest(messages, 8192);
  assert.equal(out.dropped, 0);
  assert.equal(out.messages, messages);
});

test('splitForSummarize: old turns dropped, newest kept', () => {
  const messages = [
    { role: 'system', content: 'SYS' },
    ...Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `turn-${i} ${'x'.repeat(400)}` })),
  ];
  const { keep, dropped, system } = splitForSummarize(messages, 1000);
  assert.equal(system.length, 1);
  assert.ok(dropped.length >= 5, 'older half summarized');
  assert.ok(keep.length >= 1, 'newest kept');
  assert.equal(keep.at(-1).content, messages.at(-1).content, 'last message in keep');
});

test('config validation: compaction + contextWindows', () => {
  const base = {
    name: 'C', apiKey: 'cloud-key-1234', host: '127.0.0.1', port: 4141,
    selection: { strategy: 'sticky', pool: 'free', weights: {}, timeboxMs: 700, attemptTimeoutMs: 5000 },
    providers: {}, probe: { intervalMs: 1000, standbyWarm: 0 }, refresh: { catalogMinutes: 1 },
    decision: { enabled: false, model: 'm', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
  };
  validateConfig({ ...base, compaction: { strategy: 'summarize', summarizeTimeoutMs: 15000 }, contextWindows: { 'm1': 4096 } });
  assert.throws(() => validateConfig({ ...base, compaction: { strategy: 'nope', summarizeTimeoutMs: 15000 } }), /compaction\.strategy/);
  assert.throws(() => validateConfig({ ...base, compaction: { strategy: 'summarize', summarizeTimeoutMs: 10 } }), /summarizeTimeoutMs/);
  assert.throws(() => validateConfig({ ...base, contextWindows: { m1: 10 } }), /contextWindows/);
});

test('integration: window overflow triggers summarize via upstream, x_router marker set', async () => {
  let lastChatBody = null;
  let summarizeCalls = 0;
  const mock = http.createServer((req, res) => {
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
        const isSummarize = body.messages?.[0]?.content?.includes('Summarize the following');
        if (isSummarize) summarizeCalls += 1;
        const content = isSummarize ? 'USER wants a purple widget. Decided: use API X. Pending: ship Friday.' : 'ok';
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const { startServer } = await import('../src/server.mjs');
  const { refresh } = await import('../src/catalog.mjs');
  const { resetRateLimiter } = await import('../src/security.mjs');
  const port = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  });
  const cfg = {
    name: 'Cloud', apiKey: 'cloud-ctx-key', host: '127.0.0.1', port, autoDiscover: false,
    selection: { strategy: 'sticky', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 5000 },
    providers: {
      zen: { enabled: true, importOpencodeAuth: false, keys: ['zen-key-0001'], baseUrl: `http://127.0.0.1:${mock.address().port}` },
      openrouter: { enabled: true, keys: [] }, groq: { enabled: true, keys: [] }, gemini: { enabled: true, keys: [] },
    },
    probe: { intervalMs: 600000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    security: { rateLimitPerMin: 600, allowedIps: [] },
    persona: { enabled: false, prependClientSystem: true, prompt: '' },
    compaction: { strategy: 'summarize', summarizeTimeoutMs: 3000 },
    contextWindows: { 'echo-free': 300 },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
  };
  validateConfig(cfg);
  await refresh(cfg);
  resetRateLimiter();
  const server = startServer(cfg);
  await new Promise((r) => server.on('listening', r));
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: 'echo-free',
      messages: [
        ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `turn-${i} ${'x'.repeat(500)}` })),
        { role: 'user', content: 'current-question' },
      ],
      stream: false,
    }),
  });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.x_router?.compacted, true, 'x_router.compacted marker');
  assert.equal(payload.x_router?.mode, 'summarize');
  assert.ok(payload.x_router?.dropped >= 1);
  assert.ok(summarizeCalls >= 1, 'summarize call made upstream');
  const finalMsgs = lastChatBody.messages;
  assert.equal(finalMsgs.at(-1).content, 'current-question', 'current turn preserved');
  assert.ok(finalMsgs.some((m) => m.content?.includes('Conversation summary so far:')), 'summary injected');
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  mock.close();
});

test('integration: summarize failure falls back to truncate', async () => {
  const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'echo-free' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        const body = JSON.parse(raw);
        const isSummarize = body.messages?.[0]?.content?.includes('Summarize the following');
        if (isSummarize) { res.writeHead(500); return res.end('boom'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const { startServer } = await import('../src/server.mjs');
  const { refresh } = await import('../src/catalog.mjs');
  const { resetRateLimiter } = await import('../src/security.mjs');
  const port = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  });
  const cfg = {
    name: 'Cloud', apiKey: 'cloud-ctx-key2', host: '127.0.0.1', port, autoDiscover: false,
    selection: { strategy: 'sticky', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 5000 },
    providers: {
      zen: { enabled: true, importOpencodeAuth: false, keys: ['zen-key-0001'], baseUrl: `http://127.0.0.1:${mock.address().port}` },
      openrouter: { enabled: true, keys: [] }, groq: { enabled: true, keys: [] }, gemini: { enabled: true, keys: [] },
    },
    probe: { intervalMs: 600000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    security: { rateLimitPerMin: 600, allowedIps: [] },
    persona: { enabled: false, prependClientSystem: true, prompt: '' },
    compaction: { strategy: 'summarize', summarizeTimeoutMs: 2000 },
    contextWindows: { 'echo-free': 300 },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
  };
  validateConfig(cfg);
  await refresh(cfg);
  resetRateLimiter();
  const server = startServer(cfg);
  await new Promise((r) => server.on('listening', r));
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: 'echo-free',
      messages: [
        ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `turn-${i} ${'x'.repeat(500)}` })),
        { role: 'user', content: 'current-question' },
      ],
      stream: false,
    }),
  });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.x_router?.compacted, true);
  assert.equal(payload.x_router?.mode, 'truncate', 'fail-open to truncate');
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  mock.close();
});
