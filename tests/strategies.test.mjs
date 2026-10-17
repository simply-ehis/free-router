// @body:organ=muscle type=test role="strategies: ordering, sticky, roundrobin, timebox fallback"
import test from 'node:test';
import assert from 'node:assert/strict';
import { select, registry, scoreModel } from '../src/strategies/index.mjs';

const cfg = (over = {}) => ({
  selection: { strategy: 'sticky', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 1000, ...over },
});

const models = ['a-free', 'b-free', 'c-free'].map((id) => ({ id, provider: 'zen', protocol: 'chat' }));
const state = (m) => ({ latencyMs: m.latencyMs ?? null, ok: m.ok ?? 0, fail: m.fail ?? 0 });
const ctx = (extra = {}) => ({ models, cfg: cfg(), needsTools: false, previous: null, states: new Map(), ...extra });

test('unknown strategy falls back to default order', async () => {
  const ids = await select(cfg({ strategy: 'nope' }), ctx());
  assert.deepEqual(ids, ['a-free', 'b-free', 'c-free']);
});

test('slow strategy times out and falls back to default order', async () => {
  registry.__slow = { name: '__slow', order: () => new Promise((r) => setTimeout(() => r(['c-free']), 5000).unref()) };
  try {
    const t0 = Date.now();
    const ids = await select(cfg({ strategy: '__slow', timeboxMs: 60 }), ctx());
    assert.ok(Date.now() - t0 < 1000, 'must return within timebox');
    assert.deepEqual(ids, ['a-free', 'b-free', 'c-free']);
  } finally { delete registry.__slow; }
});

test('strategy returning junk is sanitized, missing models appended', async () => {
  registry.__junk = { name: '__junk', order: () => ['ghost', 'c-free'] };
  try {
    const ids = await select(cfg({ strategy: '__junk' }), ctx());
    assert.deepEqual(ids, ['c-free', 'a-free', 'b-free']);
  } finally { delete registry.__junk; }
});

test('sticky puts previous route first', async () => {
  const ids = await select(cfg(), ctx({ previous: { modelId: 'b-free' } }));
  assert.deepEqual(ids, ['b-free', 'a-free', 'c-free']);
});

test('roundrobin rotates the head across calls', async () => {
  const c = cfg({ strategy: 'roundrobin' });
  const first = await select(c, ctx({ cfg: c }));
  const second = await select(c, ctx({ cfg: c }));
  assert.notDeepEqual(first, second);
  assert.deepEqual([...first].sort(), ['a-free', 'b-free', 'c-free']);
});

test('smartest uses normalized four-factor weights and configured model priority', async () => {
  const c = cfg({ strategy: 'smartest', weights: { success: 0, latency: 0, freshness: 0, priority: 1 }, priorities: { 'a-free': 1, 'b-free': 0 } });
  const ids = await select(c, ctx({ cfg: c, states: new Map() }));
  assert.equal(ids[0], 'a-free');
  assert.equal(scoreModel('a-free', { ...ctx(), cfg: c, states: new Map() }), 1);
});

test('verified free evidence outranks unverified equals in smartest order', async () => {
  const c = cfg({ strategy: 'smartest' });
  const sources = new Map([['a-free', []], ['b-free', ['suffix']], ['c-free', ['models.dev']]]);
  const c2 = ctx({ cfg: c, states: new Map(), sources });
  const ids = await select(c, c2);
  assert.ok(!ids.slice(0, 1).includes('a-free'), 'unverified model must not lead a verified field');
  assert.deepEqual([...ids].sort(), ['a-free', 'b-free', 'c-free'], 'every candidate still routed');
  assert.ok(scoreModel('b-free', c2) > scoreModel('a-free', c2), 'verified scores above unverified');
  assert.ok(scoreModel('c-free', c2) > scoreModel('a-free', c2), 'any evidence beats no evidence');
});

test('without evidence the verified component drops out and weights renormalize', () => {
  const c = cfg({ strategy: 'smartest', weights: { success: 0, latency: 0, freshness: 0, priority: 1 }, priorities: { 'a-free': 1 } });
  assert.equal(scoreModel('a-free', { ...ctx(), cfg: c, states: new Map() }), 1, 'no sources map → verified never dilutes the score');
});

test('fastest orders by latency ascending, unknown latency last', async () => {
  const c = cfg({ strategy: 'fastest' });
  const states = new Map([
    ['a-free', state({ latencyMs: 50 })],
    ['b-free', state({ latencyMs: 10 })],
    ['c-free', state({ latencyMs: null })],
  ]);
  const ids = await select(c, ctx({ cfg: c, states }));
  assert.deepEqual(ids, ['b-free', 'a-free', 'c-free']);
});
