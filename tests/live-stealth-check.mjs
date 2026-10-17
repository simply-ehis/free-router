// Live P11 gate: stealth stream + models list against a TEMP config (real config untouched).
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = await new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
});
const mockPort = await new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
});

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
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: '1 2 3' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    }
  });
});
mock.listen(mockPort, '127.0.0.1');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-live-stealth-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');
writeFileSync(process.env.FREE_ROUTER_CONFIG, JSON.stringify({
  name: 'Cloud', apiKey: 'cloud-live-stealth-key', host: '127.0.0.1', port,
  selection: { strategy: 'sticky', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 5000 },
  providers: {
    zen: { enabled: true, importOpencodeAuth: false, keys: ['zen-live-key-0001'], baseUrl: `http://127.0.0.1:${mockPort}` },
    openrouter: { enabled: true, keys: [] },
    groq: { enabled: true, keys: [] },
    gemini: { enabled: true, keys: [] },
  },
  probe: { intervalMs: 600000, standbyWarm: 0 },
  refresh: { catalogMinutes: 10 },
  security: { rateLimitPerMin: 60, allowedIps: [] },
  stealth: { enabled: true, alias: 'cloud-1', scrubContent: false },
  decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
}, null, 2));

const { loadConfig } = await import('../src/config.mjs');
const { refresh } = await import('../src/catalog.mjs');
const { startServer } = await import('../src/server.mjs');

const cfg = loadConfig();
await refresh(cfg);
const server = startServer(cfg);
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${cfg.apiKey}` };

const models = await fetch(`${base}/v1/models`, { headers: auth });
const modelsText = await models.text();
const modelsJson = JSON.parse(modelsText);
console.log('GET /v1/models ->', models.status, 'ids:', modelsJson.data.map((d) => d.id).join(','), '| real id on wire:', modelsText.includes('echo-free'));

const stream = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'cloud-1', messages: [{ role: 'user', content: 'hi' }], stream: true }),
});
const streamText = await stream.text();
console.log('POST stream ->', stream.status,
  '| model field alias:', streamText.includes('"model":"cloud-1"'),
  '| model field real:', streamText.includes('"model":"echo-free"'),
  '| content:', streamText.includes('1 2 3'),
  '| [DONE]:', streamText.includes('[DONE]'));

server.closeAllConnections?.();
await new Promise((r) => server.close(r));
mock.close();
console.log('P11 live stealth proof done');
