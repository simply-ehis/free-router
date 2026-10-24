// @body:organ=muscle type=test role="Worker persistence: durable saves keep secrets out of KV, boot never overwrites newer settings, isolates pick up each other's changes, writes coalesce"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FREE_ROUTER_CONFIG = path.join(mkdtempSync(path.join(os.tmpdir(), 'fr-wsync-')), 'config.json');

const { bootConfig, syncFromKv, resetSyncState, REV_KEY, drainPending, poolSignature } = await import('../src/workerConfig.mjs');
const { CONFIG_PATH, API_KEYS_PATH, saveConfigDurable } = await import('../src/config.mjs');
const { store, resetStore } = await import('../src/store.mjs');
const { setRuntimePlatform } = await import('../src/runtime.mjs');

const SECRET = Buffer.alloc(32, 5).toString('base64url');
const env = { GATEWAY_KEY: 'worker-test-password-123', COMPAT_CREDENTIALS_KEY: SECRET, CONFIG: '{}' };

function fakeKv(initial = {}, { delayMs = 0 } = {}) {
  const data = new Map(Object.entries(initial));
  const puts = [];
  return {
    data, puts,
    async list() { return { keys: [...data.keys()].map((name) => ({ name })) }; },
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async put(k, v) { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); puts.push(k); data.set(k, v); },
  };
}

test.beforeEach(() => { resetSyncState(); setRuntimePlatform('worker'); });
test.after(() => { resetStore(); setRuntimePlatform('node'); });

test('durable config save: lands in KV before resolving, without the dashboard password or keys, and bumps the revision', async () => {
  const kv = fakeKv();
  const { cfg } = await bootConfig(env, kv);
  cfg.providers.groq.keys = ['gsk_secret_key_value_1'];
  cfg.selection.pool = 'all';
  await saveConfigDurable(cfg);
  const stored = kv.data.get(CONFIG_PATH);
  assert.ok(stored, 'config reached KV');
  assert.doesNotMatch(stored, /worker-test-password-123|gsk_secret_key_value_1|dashboardPassword/, 'no secrets in the KV config');
  assert.equal(JSON.parse(stored).selection.pool, 'all');
  assert.ok(kv.data.get(REV_KEY), 'revision bumped so other isolates re-read');
});

test('boot does not overwrite settings another isolate already saved', async () => {
  const kv = fakeKv({ [CONFIG_PATH]: JSON.stringify({ selection: { pool: 'all', strategy: 'smartest' } }) });
  const { cfg } = await bootConfig(env, kv);
  assert.equal(cfg.selection.strategy, 'smartest');
  await drainPending();
  assert.deepEqual(kv.puts.filter((k) => k === CONFIG_PATH), [], 'cold start must not write the config back');
  const first = fakeKv();
  await bootConfig(env, first);
  await drainPending();
  assert.ok(first.data.has(CONFIG_PATH), 'a brand-new namespace is seeded once');
});

test('another isolate\'s change (settings, client keys, provider keys) shows up in the live cfg without a restart', async () => {
  const kv = fakeKv();
  const { cfg } = await bootConfig(env, kv);
  const liveRef = cfg;
  const before = poolSignature(cfg);

  // "isolate B" saves: new strategy + pool, a client key, a groq key — straight into KV with a new rev
  const { encryptProviderKeys } = await import('../src/providerCredentials.mjs');
  const other = JSON.parse(kv.data.get(CONFIG_PATH) ?? '{}');
  other.selection = { ...(other.selection ?? {}), strategy: 'fastest', pool: 'all', forceChat: ['x-model'] };
  other.providers = { ...(other.providers ?? {}), groq: { ...(other.providers?.groq ?? {}), enabled: false } };
  kv.data.set(CONFIG_PATH, JSON.stringify(other));
  kv.data.set(API_KEYS_PATH, JSON.stringify([{ id: 'abc', label: 'cline', hash: 'a'.repeat(64), createdAt: new Date().toISOString(), enabled: true }]));
  kv.data.set('provider-key-envelope', 'ignored');
  const providerPath = (await import('../src/config.mjs')).PROVIDER_CREDENTIALS_PATH;
  kv.data.set(providerPath, await encryptProviderKeys({ cerebras: ['csk-from-isolate-b-0001'] }, SECRET));
  kv.data.set(REV_KEY, 'rev-2');

  const out = await syncFromKv(env, kv, cfg, { minIntervalMs: 0 });
  assert.equal(out.changed, true);
  assert.equal(out.poolChanged, true);
  assert.equal(cfg, liveRef, 'folded into the SAME object other modules reference');
  assert.equal(cfg.selection.strategy, 'fastest');
  assert.equal(cfg.selection.pool, 'all');
  assert.deepEqual(cfg.selection.forceChat, ['x-model']);
  assert.equal(cfg.providers.groq.enabled, false);
  assert.equal(cfg.apiKeys.length, 1, 'a client key created elsewhere authenticates here too');
  assert.deepEqual(cfg.providers.cerebras.keys, ['csk-from-isolate-b-0001']);
  assert.notEqual(poolSignature(cfg), before);

  const again = await syncFromKv(env, kv, cfg, { minIntervalMs: 0 });
  assert.equal(again.changed, false, 'unchanged revision costs one KV read and changes nothing');
});

test('sync is throttled and never throws when KV is down', async () => {
  const kv = fakeKv();
  const { cfg } = await bootConfig(env, kv);
  kv.data.set(REV_KEY, 'rev-9');
  assert.equal((await syncFromKv(env, kv, cfg, { minIntervalMs: 0 })).changed, true);
  kv.data.set(REV_KEY, 'rev-10');
  assert.equal((await syncFromKv(env, kv, cfg, { minIntervalMs: 60_000 })).changed, false, 'throttled');
  const broken = { ...kv, get: async () => { throw new Error('kv down'); } };
  assert.deepEqual(await syncFromKv(env, broken, cfg, { minIntervalMs: 0 }), { changed: false, poolChanged: false });
});

test('burst of appends is coalesced into a couple of KV writes, and drainPending waits for them', async () => {
  const kv = fakeKv({}, { delayMs: 5 });
  await bootConfig(env, kv);
  await drainPending();
  kv.puts.length = 0;
  for (let i = 0; i < 25; i += 1) store.append('logs/audit.jsonl', `${JSON.stringify({ i })}\n`);
  await drainPending();
  const writes = kv.puts.filter((k) => k === 'logs/audit.jsonl').length;
  assert.ok(writes <= 3, `expected ≤3 KV writes for 25 appends, got ${writes}`);
  assert.equal(kv.data.get('logs/audit.jsonl').split('\n').filter(Boolean).length, 25, 'nothing lost');
});
