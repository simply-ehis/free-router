import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FREE_ROUTER_CONFIG = path.join(mkdtempSync(path.join(os.tmpdir(), 'fr-ms-')), 'config.json');

const { modelStatus, recordOutcome, resetState } = await import('../src/routes.mjs');

test('modelStatus: untested when no state', () => {
  resetState();
  assert.equal(modelStatus('nope'), 'untested');
});

test('modelStatus: working after success', () => {
  resetState();
  recordOutcome('m1', true);
  assert.equal(modelStatus('m1'), 'working');
});

test('modelStatus: failed after only failures', () => {
  resetState();
  recordOutcome('m2', false);
  recordOutcome('m2', false);
  recordOutcome('m2', false);
  assert.equal(modelStatus('m2'), 'failed');
});

test('modelStatus: degraded after mixed', () => {
  resetState();
  recordOutcome('m3', true);
  recordOutcome('m3', false);
  assert.equal(modelStatus('m3'), 'degraded');
});
