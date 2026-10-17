// @body:organ=muscle type=test role="P16 discovery: env + auth.json keys, generic openai-compat adapter"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { byId } from '../src/providers/index.mjs';
import { refresh, getState as getCatalog } from '../src/catalog.mjs';
import { discoverProviderKeys, mergeDiscovered } from '../src/discovery.mjs';

const ENV_SAVE = ['GROQ_API_KEY', 'ZEN_API_KEY', 'OPENCODE_API_KEY', 'FREE_ROUTER_AUTH_JSON'];
// Always pin FREE_ROUTER_AUTH_JSON so the real ~/.local/share/opencode/auth.json
// never leaks into fixtures (tests set their own path when they need one).
const NO_AUTH_PATH = path.join(tmpdir(), 'fr-no-such-auth.json');
function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_SAVE) saved[k] = process.env[k];
  for (const k of Object.keys(vars)) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  if (!('FREE_ROUTER_AUTH_JSON' in vars)) process.env.FREE_ROUTER_AUTH_JSON = NO_AUTH_PATH;
  try { return fn(); } finally {
    for (const k of ENV_SAVE) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function listen(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

function baseCfg(over = {}) {
  return {
    name: 'test', apiKey: 'cloud-test-key', host: '127.0.0.1', port: 41419, autoDiscover: false,
    selection: { strategy: 'sticky', pool: 'all', weights: {}, timeboxMs: 80, attemptTimeoutMs: 2000 },
    providers: {},
    probe: { intervalMs: 60000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
    ...over,
  };
}

test('discovery: env vars surface as ephemeral creds, keyed per provider', () => {
  withEnv({ GROQ_API_KEY: 'gq-env-key-12345', ZEN_API_KEY: undefined }, () => {
    const found = discoverProviderKeys({ autoDiscover: true });
    assert.equal(found.groq?.length, 1);
    assert.equal(found.groq[0].key, 'gq-env-key-12345');
    assert.match(found.groq[0].source, /^env:/);
    assert.equal(found.zen, undefined, 'unset vars produce nothing');
  });
});

test('discovery: autoDiscover:false returns empty even with env set', () => {
  withEnv({ GROQ_API_KEY: 'gq-env-key-12345' }, () => {
    assert.deepEqual(discoverProviderKeys({ autoDiscover: false }), {});
  });
});

test('discovery: auth.json maps known providers, ignores unknown + oauth entries', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fr-auth-'));
  const authPath = path.join(dir, 'auth.json');
  writeFileSync(authPath, JSON.stringify({
    opencode: { type: 'api', key: 'zen-auth-key-12345' },
    groq: { type: 'api', key: 'gq-auth-key-12345' },
    anthropic: { type: 'api', key: 'sk-ant-should-be-ignored' },
    openai: { type: 'oauth', access: 'tok', key: 'x' },
  }));
  withEnv({ FREE_ROUTER_AUTH_JSON: authPath }, () => {
    const found = discoverProviderKeys({ autoDiscover: true });
    assert.equal(found.zen?.length, 1);
    assert.equal(found.zen[0].key, 'zen-auth-key-12345');
    assert.equal(found.groq?.length, 1);
    assert.equal(found.zen[0].source, 'opencode-auth');
    assert.equal(found.openrouter, undefined);
    // short/invalid key values are skipped (length guard) — openai 'x' above
    const merged = mergeDiscovered('zen', { autoDiscover: true }, [{ provider: 'zen', label: 'cfg-0', key: 'zen-auth-key-12345' }]);
    assert.equal(merged.length, 1, 'dedup by key value');
    assert.equal(merged[0].source, undefined, 'config cred wins, no source tag');
  });
});

test('mergeDiscovered: appends with source tag, dedups by value', () => {
  withEnv({ GROQ_API_KEY: 'gq-env-key-12345' }, () => {
    const cfg = { autoDiscover: true };
    const creds = mergeDiscovered('groq', cfg, [{ provider: 'groq', label: 'gq-0', key: 'other-key' }]);
    assert.equal(creds.length, 2);
    assert.equal(creds[1].source, 'env:GROQ_API_KEY');
    const deduped = mergeDiscovered('groq', cfg, [{ provider: 'groq', label: 'gq-0', key: 'gq-env-key-12345' }]);
    assert.equal(deduped.length, 1);
  });
});

test('zen listCredentials: discovered env key joins config creds (autoDiscover on)', () => {
  withEnv({ ZEN_API_KEY: 'zen-env-key-12345' }, () => {
    const cfg = baseCfg({ autoDiscover: true, providers: { zen: { enabled: true, keys: ['zk-cfg-1'], importOpencodeAuth: false, baseUrl: '' } } });
    const creds = byId.zen.listCredentials(cfg);
    assert.equal(creds.length, 3);
    assert.ok(creds.some((c) => c.source === 'env:ZEN_API_KEY'), 'discovered cred tagged');
    assert.ok(creds.some((c) => c.label === 'zen-1'), 'config cred intact');
    assert.equal(creds.at(-1).label, 'anonymous', 'anonymous lane always last');
    assert.equal(creds.at(-1).key, 'public');
  });
});

test('openai-compat: config validation rejects bad instances', () => {
  const badUrl = baseCfg({ providers: { 'openai-compat': { enabled: true, instances: [{ baseUrl: 'ftp://x', apiKey: 'k' }] } } });
  assert.throws(() => validateConfig(badUrl), /baseUrl/);
  const badPrefix = baseCfg({ providers: { 'openai-compat': { enabled: true, instances: [{ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', prefix: 'Bad_Prefix!' }] } } });
  assert.throws(() => validateConfig(badPrefix), /prefix/);
  const badInstances = baseCfg({ providers: { 'openai-compat': { enabled: true, instances: {} } } });
  assert.throws(() => validateConfig(badInstances), /array/);
  const ok = baseCfg({ providers: { 'openai-compat': { enabled: true, instances: [{ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', prefix: 'fb', models: ['m1'] }] } } });
  assert.equal(validateConfig(ok), true);
});

test('openai-compat: listModelIds prefixes auto-listed ids; configured models skip fetch', async () => {
  let listHits = 0;
  const mock = await listen((req, res) => {
    if (req.url === '/models' && req.method === 'GET') {
      listHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'upstream-a' }, { id: 'upstream-b' }] }));
    }
    res.writeHead(404); res.end();
  });
  try {
    const cfg = baseCfg({ providers: { 'openai-compat': { enabled: true, instances: [
      { baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'k1', prefix: 'fb' },
      { baseUrl: 'http://127.0.0.1:9', apiKey: 'k2', prefix: 'fixed', models: ['m1', 'm2'] },
    ] } } });
    assert.equal(byId['openai-compat'].isEnabled(cfg), true);
    const ids = await byId['openai-compat'].listModelIds(cfg);
    assert.deepEqual(ids.sort(), ['fb:upstream-a', 'fb:upstream-b', 'fixed:m1', 'fixed:m2']);
    assert.equal(listHits, 1, 'only the instance without models[] hits /models');
    assert.deepEqual(byId['openai-compat'].freeSources(), [], 'compat makes no free claims');
  } finally { await mock.close(); }
});

test('openai-compat: chat strips prefix before upstream, streams bytes untouched', async () => {
  const seen = { body: null, auth: null };
  const sse = 'data: {"id":"c1","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
  const mock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.body = JSON.parse(raw);
      seen.auth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse);
    });
  });
  try {
    const cred = { provider: 'openai-compat', label: 'fb', key: 'inst-key', instance: { baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'inst-key', prefix: 'fb' } };
    const res = await byId['openai-compat'].chat(baseCfg(), cred, { model: 'fb:upstream-a', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(await res.text(), sse, 'stream bytes relayed verbatim');
    assert.equal(seen.body.model, 'upstream-a', 'prefix stripped for upstream');
    assert.equal(seen.auth, 'Bearer inst-key');
  } finally { await mock.close(); }
});

test('openai-compat: catalog refresh surfaces prefixed models; classification buckets', async () => {
  const mock = await listen((req, res) => {
    if (req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'alpha-1' }] }));
    }
    res.writeHead(404); res.end();
  });
  try {
    const cfg = baseCfg({ providers: { 'openai-compat': { enabled: true, instances: [
      { baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'k', prefix: 'fb' },
    ] } } });
    validateConfig(cfg);
    await refresh(cfg);
    const entry = getCatalog().models.find((m) => m.id === 'fb:alpha-1');
    assert.ok(entry, 'prefixed id in catalog');
    assert.equal(entry.provider, 'openai-compat');
    assert.deepEqual(entry.sources, []);
    const classify = byId['openai-compat'].classifyError;
    assert.equal(classify(402), 'billing');
    assert.equal(classify(429), 'ratelimit');
    assert.equal(classify(401), 'auth');
    assert.equal(classify(500), 'transient');
    assert.equal(classify(404), 'notfound');
  } finally { await mock.close(); }
});
