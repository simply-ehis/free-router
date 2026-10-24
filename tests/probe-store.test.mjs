// @body:organ=muscle type=test role="probe state persistence: round trip, staleness, corrupt input, flush throttling, restore never overwrites fresher in-process results"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FREE_ROUTER_CONFIG = path.join(mkdtempSync(path.join(os.tmpdir(), 'fr-pstore-')), 'config.json');

const { serializeProbeState, parseProbeState } = await import('../src/probeStore.mjs');
const { restoreProbeState, getProbeState } = await import('../src/probe.mjs');

const NOW = 1_800_000_000_000;
const e = (over = {}) => ({ lastOk: 0, lastErr: null, lastWarmAt: 0, okCount: 0, failCount: 0, lastMs: null, lastLimited: 0, checkedAt: 0, ...over });

test('round trip keeps what was measured and drops what was never checked', () => {
  const map = new Map([
    ['ok-model', e({ lastOk: NOW - 1000, lastMs: 42, okCount: 3, checkedAt: NOW - 1000 })],
    ['bad-model', e({ lastErr: { kind: 'transient', status: 500, at: NOW - 500 }, failCount: 1, checkedAt: NOW - 500 })],
    ['limited-model', e({ lastLimited: NOW - 200, checkedAt: NOW - 200 })],
    ['never-checked', e()],
  ]);
  const back = parseProbeState(serializeProbeState(map, NOW), NOW);
  assert.deepEqual([...back.keys()].sort(), ['bad-model', 'limited-model', 'ok-model']);
  assert.equal(back.get('ok-model').lastMs, 42);
  assert.deepEqual(back.get('bad-model').lastErr, { kind: 'transient', status: 500, at: NOW - 500 });
  assert.equal(back.get('limited-model').lastLimited, NOW - 200);
});

test('week-old results are forgotten (stale health is misleading)', () => {
  const map = new Map([['old', e({ lastOk: NOW - 8 * 24 * 3_600_000 })], ['fresh', e({ lastOk: NOW - 3_600_000 })]]);
  assert.deepEqual([...parseProbeState(serializeProbeState(map, NOW), NOW).keys()], ['fresh']);
  const text = JSON.stringify({ old: e({ lastOk: NOW - 9 * 24 * 3_600_000 }) });
  assert.equal(parseProbeState(text, NOW).size, 0);
});

test('corrupt or hostile input never throws and never injects junk', () => {
  for (const text of [undefined, null, '', 'not json', '[]', '"x"', '{"a":1}', '{"a":null}']) assert.equal(parseProbeState(text, NOW).size, 0, String(text));
  const hostile = parseProbeState(JSON.stringify({ m: { lastOk: -5, lastMs: 'fast', lastLimited: NOW - 10, lastErr: { kind: 7 }, okCount: 'many' } }), NOW);
  const m = hostile.get('m');
  assert.equal(m.lastOk, 0);
  assert.equal(m.lastMs, null);
  assert.equal(m.lastErr, null);
  assert.equal(m.okCount, 0);
});

test('restore fills the gaps but never overwrites a fresher in-process result', () => {
  const now = Date.now();
  restoreProbeState(JSON.stringify({ 'restored-model': e({ lastOk: now - 5000, checkedAt: now - 5000 }) }), now);
  assert.equal(getProbeState()['restored-model'].lastOk, now - 5000);
  restoreProbeState(JSON.stringify({ 'restored-model': e({ lastOk: now - 99000 }) }), now);
  assert.equal(getProbeState()['restored-model'].lastOk, now - 5000, 'second restore does not clobber');
});
