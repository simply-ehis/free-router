// @body:organ=muscle type=test role="P23 worker key persistence: AES-GCM provider envelope crypto, boot restore, dashboard mutations with rollback + 503 guards"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-worker-keys-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');

const { bootConfig } = await import('../src/workerConfig.mjs');
const { PROVIDER_CREDENTIALS_PATH } = await import('../src/config.mjs');
const { setStore, resetStore } = await import('../src/store.mjs');
const { setRuntimePlatform } = await import('../src/runtime.mjs');
const { encryptProviderKeys, decryptProviderKeys, persistProviderKeys, configureProviderCredentials } = await import('../src/providerCredentials.mjs');
const { addKeys, removeKey, toggleKey } = await import('../src/providerKeys.mjs');

const SECRET = Buffer.alloc(32, 7).toString('base64url'); // 43-char base64url 32-byte key
const WRONG_SECRET = Buffer.alloc(32, 9).toString('base64url');

function fakeKv(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async list() { return { keys: [...data.keys()].map((name) => ({ name })) }; },
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async put(k, v) { data.set(k, v); },
  };
}

// ---------- envelope crypto ----------

test('provider envelope: round-trip preserves strings and {key,enabled} entries, including empty providers', async () => {
  const byProvider = {
    groq: ['gk-string-000001', { key: 'gk-object-000002', enabled: false }],
    zen: [],
  };
  const serialized = await encryptProviderKeys(byProvider, SECRET);
  assert.ok(!serialized.includes('gk-string-000001'), 'plaintext keys never appear in the envelope');
  assert.deepEqual(await decryptProviderKeys(serialized, SECRET), byProvider);
});

test('provider envelope: tampered ciphertext, wrong secret, and malformed input all throw', async () => {
  const serialized = await encryptProviderKeys({ groq: ['gk-tamper-000001'] }, SECRET);
  const env = JSON.parse(serialized);
  const flipped = env.providers.groq.ciphertext;
  env.providers.groq.ciphertext = (flipped[0] === 'A' ? 'B' : 'A') + flipped.slice(1);
  await assert.rejects(() => decryptProviderKeys(JSON.stringify(env), SECRET));
  await assert.rejects(() => decryptProviderKeys(serialized, WRONG_SECRET));
  await assert.rejects(() => decryptProviderKeys('{not json', SECRET));
  await assert.rejects(() => decryptProviderKeys('{"version":2,"providers":{}}', SECRET));
});

test('provider envelope: AAD binds ciphertext to its provider (entries cannot be swapped)', async () => {
  const env = JSON.parse(await encryptProviderKeys({ groq: ['gk-one-0000000001'], zen: ['zk-one-0000000001'] }, SECRET));
  const swap = env.providers.groq;
  env.providers.groq = env.providers.zen;
  env.providers.zen = swap;
  await assert.rejects(() => decryptProviderKeys(JSON.stringify(env), SECRET));
});

test('provider envelope: persist writes durable envelope; untouched providers are not recorded', async () => {
  configureProviderCredentials(SECRET);
  const store = { read: () => null, async writeDurable(p, text) { this.saved = { p, text }; } };
  const cfg = { providers: { groq: { keys: ['gk-persist-000001'] }, zen: { keys: [] } } };
  await persistProviderKeys(cfg, store, 'env-path', 'groq');
  assert.equal(store.saved.p, 'env-path');
  const restored = await decryptProviderKeys(store.saved.text, SECRET);
  assert.deepEqual(restored, { groq: ['gk-persist-000001'] }, 'only the touched provider is recorded');
});

// ---------- boot restore (isolate recycle) ----------

const BOOT_ENV = { GATEWAY_KEY: 'cloud-worker-keys-test', FREE_ROUTER_GROQ_KEYS: 'gk-stub-000001', COMPAT_CREDENTIALS_KEY: SECRET };

test('worker keys: dashboard-added key survives isolate recycle; config in KV stays keyless', async () => {
  const kv = fakeKv();
  const { cfg } = await bootConfig(BOOT_ENV, kv);
  setRuntimePlatform('worker');
  try {
    const out = await addKeys(cfg, 'groq', ['gk-real-000002']);
    assert.equal(out.error, undefined);
    const blob = kv.data.get(PROVIDER_CREDENTIALS_PATH);
    assert.ok(blob, 'envelope persisted to KV');
    assert.ok(!blob.includes('gk-real-000002'), 'envelope holds no plaintext keys');
    const configBlob = [...kv.data.entries()].find(([k]) => k.endsWith('config.json'))[1];
    assert.ok(!configBlob.includes('gk-real-000002') && !configBlob.includes('gk-stub-000001'), 'config blob in KV stays keyless');
  } finally {
    setRuntimePlatform('node');
  }
  const { cfg: second } = await bootConfig(BOOT_ENV, kv);
  assert.deepEqual(second.providers.groq.keys, ['gk-stub-000001', 'gk-real-000002'], 'key restored after recycle');
  assert.deepEqual(second.providers.zen.keys, [], 'untouched provider keeps env behavior');
});

test('worker keys: removing an env-seeded stub survives recycle; clearing a provider stays cleared', async () => {
  const kv = fakeKv();
  const { cfg } = await bootConfig(BOOT_ENV, kv);
  setRuntimePlatform('worker');
  try {
    await addKeys(cfg, 'groq', ['gk-real-000002']);
    const removed = await removeKey(cfg, 'groq', 'groq-1'); // the env stub
    assert.equal(removed.error, undefined);
  } finally {
    setRuntimePlatform('node');
  }
  const { cfg: second } = await bootConfig(BOOT_ENV, kv);
  assert.deepEqual(second.providers.groq.keys, ['gk-real-000002'], 'deleted stub does NOT roll back in');

  setRuntimePlatform('worker');
  try {
    const last = await removeKey(second, 'groq', 'groq-1');
    assert.equal(last.error, undefined);
  } finally {
    setRuntimePlatform('node');
  }
  const { cfg: third } = await bootConfig(BOOT_ENV, kv);
  assert.deepEqual(third.providers.groq.keys, [], 'empty array recorded so env stubs are not resurrected');
});

test('worker keys: toggle persists enabled:false across recycle', async () => {
  const kv = fakeKv();
  const { cfg } = await bootConfig(BOOT_ENV, kv);
  setRuntimePlatform('worker');
  try {
    const out = await toggleKey(cfg, 'groq', 'groq-1', false);
    assert.equal(out.error, undefined);
  } finally {
    setRuntimePlatform('node');
  }
  const { cfg: second } = await bootConfig(BOOT_ENV, kv);
  assert.deepEqual(second.providers.groq.keys, [{ key: 'gk-stub-000001', enabled: false }]);
});

// ---------- guards and rollback ----------

test('worker keys: without COMPAT_CREDENTIALS_KEY mutations are refused with 503 and cfg unchanged', async () => {
  const env = { GATEWAY_KEY: 'cloud-no-secret-test', FREE_ROUTER_GROQ_KEYS: 'gk-stub-000001' };
  const { cfg } = await bootConfig(env, fakeKv());
  setRuntimePlatform('worker');
  try {
    for (const out of [
      await addKeys(cfg, 'groq', ['gk-real-000002']),
      await removeKey(cfg, 'groq', 'groq-1'),
      await toggleKey(cfg, 'groq', 'groq-1', false),
    ]) {
      assert.equal(out.status, 503);
      assert.ok(out.error.includes('COMPAT_CREDENTIALS_KEY'));
    }
    assert.deepEqual(cfg.providers.groq.keys, ['gk-stub-000001'], 'refusal leaves cfg untouched');
  } finally {
    setRuntimePlatform('node');
  }
});

test('worker keys: KV write failure → 503 and in-memory rollback', async () => {
  const broken = fakeKv();
  const goodPut = broken.put.bind(broken);
  broken.put = async (k, v) => {
    if (k === PROVIDER_CREDENTIALS_PATH) throw new Error('kv write failed');
    await goodPut(k, v);
  };
  const { cfg } = await bootConfig(BOOT_ENV, broken);
  setRuntimePlatform('worker');
  try {
    const out = await addKeys(cfg, 'groq', ['gk-real-000002']);
    assert.equal(out.status, 503);
    assert.deepEqual(cfg.providers.groq.keys, ['gk-stub-000001'], 'mutation rolled back');
    assert.ok(!broken.data.has(PROVIDER_CREDENTIALS_PATH), 'no envelope written');
  } finally {
    setRuntimePlatform('node');
  }
});

test('node runtime: keys add/remove unchanged, no envelope written, no secret needed', async () => {
  resetStore(); // default fs store over tmp config
  const { loadConfig } = await import('../src/config.mjs');
  const cfg = loadConfig();
  const out = await addKeys(cfg, 'groq', ['gk-node-000000001']);
  assert.equal(out.error, undefined);
  assert.deepEqual(loadConfig().providers.groq.keys, ['gk-node-000000001']);
  const rm = await removeKey(cfg, 'groq', 'groq-1');
  assert.equal(rm.error, undefined);
  assert.deepEqual(loadConfig().providers.groq.keys, []);
  assert.ok(!existsSync(PROVIDER_CREDENTIALS_PATH), 'node path never writes the envelope');
});
