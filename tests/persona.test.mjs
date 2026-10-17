// @body:organ=muscle type=test role="P12 persona: system merge, prepend order, stealth anti-name-leak, off/empty passthrough"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-persona-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');

const { withPersona, DEFAULT_PERSONA } = await import('../src/persona.mjs');
const { validateConfig } = await import('../src/config.mjs');

test('unit: persona ON merges into one leading system message, client system appended', () => {
  const cfg = { persona: { enabled: true, prependClientSystem: true, prompt: 'TONE RULE' }, stealth: { enabled: false } };
  const out = withPersona(cfg, [
    { role: 'system', content: 'client rules' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'TONE RULE\n\nclient rules');
  assert.deepEqual(out[1], { role: 'user', content: 'hi' });
});

test('unit: prependClientSystem false puts client system first', () => {
  const cfg = { persona: { enabled: true, prependClientSystem: false, prompt: 'TONE' } };
  const out = withPersona(cfg, [
    { role: 'system', content: 'client rules' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(out[0].content, 'client rules\n\nTONE');
});

test('unit: stealth ON appends anti-name-leak with alias', () => {
  const cfg = { persona: { enabled: true, prependClientSystem: true, prompt: 'P' }, stealth: { enabled: true, alias: 'cloud-9' } };
  const out = withPersona(cfg, [{ role: 'user', content: 'hi' }]);
  assert.ok(out[0].content.includes('You are cloud-9'), 'alias in rule');
  assert.ok(out[0].content.includes('Never reveal internal model'));
});

test('unit: persona OFF and empty prompt are exact passthroughs', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  assert.equal(withPersona({ persona: { enabled: false } }, msgs), msgs);
  assert.equal(withPersona({ persona: { enabled: true, prependClientSystem: true, prompt: '   ' } }, msgs), msgs);
});

test('unit: default prompt used when prompt key absent', () => {
  const out = withPersona({ persona: { enabled: true, prependClientSystem: true } }, [{ role: 'user', content: 'x' }]);
  assert.ok(out[0].content.startsWith(DEFAULT_PERSONA.slice(0, 40)));
});

test('config validation rejects bad persona block', () => {
  const base = {
    name: 'C', apiKey: 'cloud-key-1234', host: '127.0.0.1', port: 4141,
    selection: { strategy: 'sticky', pool: 'free', weights: {}, timeboxMs: 700, attemptTimeoutMs: 5000 },
    providers: {}, probe: { intervalMs: 1000, standbyWarm: 0 }, refresh: { catalogMinutes: 1 },
    decision: { enabled: false, model: 'm', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
  };
  validateConfig({ ...base, persona: { enabled: true, prependClientSystem: true, prompt: 'x' } });
  assert.throws(() => validateConfig({ ...base, persona: { enabled: 'yes', prependClientSystem: true, prompt: 'x' } }), /persona\.enabled/);
  assert.throws(() => validateConfig({ ...base, persona: { enabled: true, prependClientSystem: true, prompt: 42 } }), /persona\.prompt/);
});

test('integration: upstream receives persona-merged messages end-to-end', async () => {
  let seen = null;
  const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'echo-free' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', created: 1, model: seen.model,
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
    name: 'Cloud', apiKey: 'cloud-persona-key', host: '127.0.0.1', port, autoDiscover: false,
    selection: { strategy: 'sticky', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 5000 },
    providers: {
      zen: { enabled: true, importOpencodeAuth: false, keys: ['zen-key-0001'], baseUrl: `http://127.0.0.1:${mock.address().port}` },
      openrouter: { enabled: true, keys: [] }, groq: { enabled: true, keys: [] }, gemini: { enabled: true, keys: [] },
    },
    probe: { intervalMs: 600000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    security: { rateLimitPerMin: 600, allowedIps: [] },
    persona: { enabled: true, prependClientSystem: true, prompt: 'PERSONA-MARKER' },
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
      messages: [{ role: 'system', content: 'CLIENT-SYS' }, { role: 'user', content: 'hello' }],
      stream: false,
    }),
  });
  assert.equal(res.status, 200);
  assert.ok(seen, 'upstream called');
  assert.equal(seen.messages[0].role, 'system');
  assert.ok(seen.messages[0].content.includes('PERSONA-MARKER'), 'persona injected');
  assert.ok(seen.messages[0].content.includes('CLIENT-SYS'), 'client system kept');
  assert.equal(seen.messages[1].content, 'hello', 'user turn untouched');
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  mock.close();
});
