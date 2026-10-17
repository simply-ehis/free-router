// Live P7 gate smoke: boot the real server, check dashboard + masked status.
// The gateway key is used inside the process only — never printed.
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { refresh } from '../src/catalog.mjs';
import { startServer } from '../src/server.mjs';

const cfg = loadConfig();
await refresh(cfg);
const server = startServer(cfg);
await new Promise((r) => server.on('listening', r));
const base = `http://${cfg.host}:${cfg.port}`;

const html = await fetch(`${base}/`);
console.log('GET / ->', html.status, html.headers.get('content-type'));
const text = await html.text();
console.log('dashboard markup ok:', text.includes('free-router') && text.includes('gateway'));

const status = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${cfg.apiKey}` } });
const s = await status.json();
console.log('GET /api/status ->', status.status, {
  strategy: s.strategy,
  freeModels: s.models?.free,
  providers: s.providers?.map((p) => `${p.id}:${p.keys}`).join(' '),
});
const raw = JSON.stringify(s);
console.log('gateway key leaked in status:', raw.includes(cfg.apiKey));

server.closeAllConnections?.();
await new Promise((r) => server.close(r));
