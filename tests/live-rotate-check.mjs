// Live P10 gate: rotate gateway key, headers, rate limit — against a TEMP config
// (real config.json untouched; keys never printed, only prefixes/statuses).
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = await new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
});

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-live-rot-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');
writeFileSync(process.env.FREE_ROUTER_CONFIG, JSON.stringify({
  name: 'Cloud', apiKey: 'cloud-live-rotate-old', host: '127.0.0.1', port,
  selection: { strategy: 'sticky', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 700, attemptTimeoutMs: 5000 },
  providers: {
    zen: { enabled: true, importOpencodeAuth: false, keys: [], baseUrl: '' },
    openrouter: { enabled: true, keys: [] },
    groq: { enabled: true, keys: [] },
    gemini: { enabled: true, keys: [] },
  },
  probe: { intervalMs: 600000, standbyWarm: 0 },
  refresh: { catalogMinutes: 10 },
  security: { rateLimitPerMin: 3, allowedIps: [] },
  decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
}, null, 2));

const { loadConfig } = await import('../src/config.mjs');
const { resetRateLimiter } = await import('../src/security.mjs');
const { startServer } = await import('../src/server.mjs');

const cfg = loadConfig();
resetRateLimiter();
const server = startServer(cfg);
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${port}`;
const auth = (k) => ({ authorization: `Bearer ${k}` });

const rot = await fetch(`${base}/api/security/rotate-key`, { method: 'POST', headers: auth('cloud-live-rotate-old') });
const { apiKey: next } = await rot.json();
console.log('POST /api/security/rotate-key ->', rot.status, 'new key prefix:', next.slice(0, 12) + '…');

const old = await fetch(`${base}/api/status`, { headers: auth('cloud-live-rotate-old') });
console.log('old key after rotate ->', old.status, '(want 401)');
const fresh = await fetch(`${base}/api/status`, { headers: auth(next) });
console.log('new key ->', fresh.status, '(want 200)');

const models = await fetch(`${base}/v1/models`, { headers: auth(next) });
console.log('GET /v1/models ->', models.status, 'nosniff:', models.headers.get('x-content-type-options'), 'referrer:', models.headers.get('referrer-policy'));

resetRateLimiter();
const limited = [];
for (let i = 0; i < 4; i++) limited.push((await fetch(`${base}/v1/models`, { headers: auth(next) })).status);
console.log('rate limit (cap 3): statuses', limited.join(','), '(want 200,200,200,429)');

const audit = readFileSync(path.join(process.cwd(), 'logs', 'audit.jsonl'), 'utf8').trim().split('\n').slice(-1)[0];
console.log('audit last line has rotate:', audit.includes('security.rotate_key'), '| contains new key:', audit.includes(next));

server.closeAllConnections?.();
await new Promise((r) => server.close(r));
console.log('P10 live rotation proof done');
