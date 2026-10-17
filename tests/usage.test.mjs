// @body:organ=muscle type=test role="usage ledger: boot from disk, per-model/per-key/hourly counters, token capture, persistence, reset"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-usage-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');
mkdirSync(path.join(tmp, '.cache'), { recursive: true });
const LEDGER = path.join(tmp, '.cache', 'usage.json');

// Seed a previous run's ledger — the module must boot from it, not from zero.
const seedAt = Date.now();
writeFileSync(LEDGER, JSON.stringify({
  models: { 'seed-free': { provider: 'zen', requests: 2, ok: 2, fail: 0, tokensIn: 10, tokensOut: 20, msTotal: 100, lastAt: seedAt } },
  keys: { k1: { label: 'Cline', requests: 2, ok: 2, fail: 0, lastAt: seedAt } },
  buckets: {},
}));

const { record, getUsage, flush, resetUsage } = await import('../src/usage.mjs');

test('boots from the persisted ledger instead of starting empty', () => {
  const u = getUsage();
  const seeded = u.models.find((m) => m.id === 'seed-free');
  assert.ok(seeded, 'seeded model present after reload');
  assert.equal(seeded.requests, 2);
  assert.equal(seeded.tokensOut, 20);
  assert.equal(u.keys.find((k) => k.id === 'k1').label, 'Cline');
  assert.equal(u.totals.requests, 2);
});

test('record bumps per-model, per-key and hourly counters together', () => {
  const before = getUsage();
  const beforeHour = before.hourly.at(-1)?.requests ?? 0;
  record({ model: 'live-free', provider: 'groq', ok: true, ms: 40, tokensIn: 12, tokensOut: 34, keyId: 'k2', keyLabel: 'Cline mobile' });
  record({ model: 'live-free', provider: 'groq', ok: false, keyId: 'k2', keyLabel: 'Cline mobile' });
  const u = getUsage();
  const live = u.models.find((m) => m.id === 'live-free');
  assert.equal(live.requests, 2);
  assert.equal(live.ok, 1);
  assert.equal(live.fail, 1);
  assert.equal(live.avgMs, 40, 'latency averaged over successes only');
  assert.equal(live.tokensIn, 12);
  assert.equal(live.tokensOut, 34);
  const key = u.keys.find((k) => k.id === 'k2');
  assert.equal(key.requests, 2, 'both attempts attributed to the client key');
  assert.equal(key.label, 'Cline mobile');
  assert.equal(u.hourly.at(-1).requests, beforeHour + 2, 'hourly bucket grew by both attempts');
  assert.ok(u.totals.requests >= 4, 'totals cover seeded + new rows');
});

test('models sort by request volume, not insertion order', () => {
  record({ model: 'busy-free', provider: 'zen', ok: true, ms: 10 });
  const ids = getUsage().models.map((m) => m.id);
  assert.equal(ids[0], 'live-free', 'busiest model leads');
  assert.equal(ids.length, 3);
});

test('flush persists the ledger next to the active config', () => {
  record({ model: 'disk-free', provider: 'gemini', ok: true, ms: 5, tokensIn: 1, tokensOut: 2, keyId: 'k3', keyLabel: 'tablet' });
  flush();
  const saved = JSON.parse(readFileSync(LEDGER, 'utf8'));
  assert.ok(saved.models['disk-free'], 'model row written');
  assert.equal(saved.models['disk-free'].tokensOut, 2);
  assert.equal(saved.keys.k3.label, 'tablet');
  assert.ok(Object.keys(saved.buckets).length > 0, 'hourly history written');
});

test('reset clears counters and rewrites the persisted file', () => {
  resetUsage();
  const u = getUsage();
  assert.equal(u.totals.requests, 0);
  assert.equal(u.models.length, 0);
  assert.equal(u.hourly.length, 0);
  const saved = JSON.parse(readFileSync(LEDGER, 'utf8'));
  assert.deepEqual(saved.models, {}, 'disk ledger emptied too');
});

test('corrupt ledger file never breaks boot or recording', async () => {
  writeFileSync(LEDGER, '{not json');
  const fresh = await import(`../src/usage.mjs?corrupt=${Date.now()}`);
  fresh.record({ model: 'phoenix-free', provider: 'zen', ok: true, ms: 3 });
  assert.equal(fresh.getUsage().models.find((m) => m.id === 'phoenix-free').requests, 1);
});
