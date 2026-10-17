// @body:organ=muscle type=test role="analytics rollups: hourly success-rate/latency series, failover counting, per-provider rollup, pre-P28 ledger normalization"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-analytics-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');
mkdirSync(path.join(tmp, '.cache'), { recursive: true });

// Seed a pre-P28 ledger: buckets lack msTotal/failover entirely.
writeFileSync(path.join(tmp, '.cache', 'usage.json'), JSON.stringify({
  models: { 'legacy-model': { provider: 'zen', requests: 4, ok: 3, fail: 1, tokensIn: 10, tokensOut: 20, msTotal: 900, lastAt: Date.now() } },
  keys: {},
  buckets: { [String(Math.floor(Date.now() / 3_600_000) * 3_600_000)]: { requests: 4, ok: 3, fail: 1, tokensIn: 10, tokensOut: 20 } },
}));

const { record, getUsage, resetUsage } = await import('../src/usage.mjs');

test('pre-P28 buckets normalize: no NaN, failover/latency default to 0/null', () => {
  const u = getUsage();
  assert.equal(u.hourly.length, 1);
  assert.equal(u.hourly[0].failover, 0);
  assert.equal(u.hourly[0].successRate, 0.75);
  assert.equal(u.hourly[0].msTotal, 0);
  assert.equal(u.totals.failover, 0);
  assert.equal(u.totals.successRate, 0.75);
});

test('bucket latency + failover accumulate per attempt', () => {
  resetUsage();
  record({ model: 'm1', provider: 'groq', ok: true, ms: 200, tokensIn: 5, tokensOut: 7, attemptIndex: 0 });
  record({ model: 'm2', provider: 'groq', ok: false, attemptIndex: 1 }); // failover retry
  record({ model: 'm3', provider: 'gemini', ok: true, ms: 400, attemptIndex: 2 }); // second retry
  const u = getUsage();
  const b = u.hourly.at(-1);
  assert.equal(b.requests, 3);
  assert.equal(b.ok, 2);
  assert.equal(b.fail, 1);
  assert.equal(b.msTotal, 600); // failures never add latency
  assert.equal(b.failover, 2); // attempts beyond the first
  assert.equal(b.avgMs, 300);
  assert.ok(Math.abs(b.successRate - 2 / 3) < 1e-9);
  assert.equal(u.totals.failover, 2);
});

test('per-provider rollup sums models, sorted by requests, single math path', () => {
  const u = getUsage();
  assert.deepEqual(u.providers.map((p) => p.provider), ['groq', 'gemini']);
  const groq = u.providers[0];
  assert.equal(groq.requests, 2);
  assert.equal(groq.ok, 1);
  assert.equal(groq.fail, 1);
  assert.equal(groq.successRate, 0.5);
  assert.equal(groq.avgMs, 200);
  assert.equal(groq.tokensIn, 5);
  assert.equal(groq.tokensOut, 7);
  const gem = u.providers[1];
  assert.equal(gem.requests, 1);
  assert.equal(gem.avgMs, 400);
});

test('mutation guard: without attemptIndex nothing counts as failover', () => {
  resetUsage();
  record({ model: 'mx', provider: 'groq', ok: false }); // no attemptIndex — legacy shape
  const u = getUsage();
  assert.equal(u.totals.failover, 0);
  assert.equal(u.hourly[0].failover, 0);
});
