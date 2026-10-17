// @body:organ=muscle type=test role="P6 adapters: credentials, free detection, chat headers, catalog integration"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateConfig } from '../src/config.mjs';
import { registry, byId } from '../src/providers/index.mjs';
import { refresh, getState as getCatalog, reinstate } from '../src/catalog.mjs';

let orMock;
let groqMock;
let geminiMock;

const seen = { or: [], groq: [], gemini: [], geminiListAuth: null };

function sseOk(model, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunks = [
    { id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
}

async function listen(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

async function startMocks() {
  orMock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'org/free-a:free', pricing: { prompt: '0', completion: '0' } },
          { id: 'org/paid-b', pricing: { prompt: '1.00', completion: '2.00' } },
          { id: 'org/stealth-c', pricing: { prompt: '0', completion: '0' } },
        ] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen.or.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
  groqMock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'qwen-qwq-32b' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen.groq.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
  geminiMock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        seen.geminiListAuth = req.headers['x-goog-api-key'] ?? null;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ models: [
          { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ] }));
      }
      if (req.method === 'POST' && req.url === '/openai/chat/completions') {
        seen.gemini.push({ auth: req.headers.authorization, goog: req.headers['x-goog-api-key'], body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
}

function makeCfg() {
  const cfg = {
    name: 'test', apiKey: 'cloud-test-key', host: '127.0.0.1', port: 41419, autoDiscover: false,
    selection: { strategy: 'sticky', weights: {}, timeboxMs: 80, attemptTimeoutMs: 2000 },
    providers: {
      zen: { enabled: false, keys: [], importOpencodeAuth: false, baseUrl: '' },
      openrouter: { enabled: true, keys: ['or-key-1'], baseUrl: `http://127.0.0.1:${orMock.port}` },
      groq: { enabled: true, keys: ['gq-key-1'], baseUrl: `http://127.0.0.1:${groqMock.port}` },
      gemini: { enabled: true, keys: ['gm-key-1'], baseUrl: `http://127.0.0.1:${geminiMock.port}` },
    },
    probe: { intervalMs: 12000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
  };
  validateConfig(cfg);
  return cfg;
}

test('setup: adapters registered in the nerve; ids unique', async () => {
  await startMocks();
  assert.deepEqual(registry.map((p) => p.id), ['zen', 'openrouter', 'groq', 'gemini', 'cerebras', 'sambanova', 'mistral', 'openai-compat', 'kilo', 'ovh', 'llm7', 'zai', 'nvidia', 'qwen', 'kluster', 'huggingface']);
  assert.equal(new Set(registry.map((p) => p.id)).size, 16);
});

test('enabled:false or missing keys → zero usable credentials', () => {
  const cfg = makeCfg();
  cfg.providers.openrouter.enabled = false;
  assert.equal(byId.openrouter.isEnabled(cfg), false, 'isEnabled is the gate; catalog/refresh skip on it');
  cfg.providers.openrouter.enabled = true;
  cfg.providers.openrouter.keys = [];
  assert.equal(byId.openrouter.listCredentials(cfg).length, 0);
  assert.equal(byId.openrouter.isEnabled(cfg), true);
});

test('openrouter: free detection picks :free + zero-priced, never paid', async () => {
  const cfg = makeCfg();
  const ids = await byId.openrouter.listModelIds(cfg);
  assert.deepEqual(ids, ['org/free-a:free', 'org/paid-b', 'org/stealth-c']);
  assert.deepEqual(byId.openrouter.freeSources('org/free-a:free', null), ['suffix', 'zero-priced']);
  assert.deepEqual(byId.openrouter.freeSources('org/stealth-c', null), ['zero-priced']);
  assert.deepEqual(byId.openrouter.freeSources('org/paid-b', null), []);
});

test('groq + gemini: free-tier source for all listed models', async () => {
  const cfg = makeCfg();
  const groqIds = await byId.groq.listModelIds(cfg);
  assert.deepEqual(groqIds, ['llama-3.3-70b-versatile', 'qwen-qwq-32b']);
  assert.deepEqual(byId.groq.freeSources('llama-3.3-70b-versatile', null), ['free-tier']);

  const gemIds = await byId.gemini.listModelIds(cfg);
  assert.deepEqual(gemIds, ['gemini-2.0-flash'], 'native models/ prefix stripped, non-generateContent filtered');
  assert.equal(seen.geminiListAuth, 'gm-key-1', 'native list must authenticate');
  assert.deepEqual(byId.gemini.freeSources('gemini-2.0-flash', null), ['free-tier']);

  cfg.providers.gemini.keys = [];
  await assert.rejects(() => byId.gemini.listModelIds(cfg), /requires a key/);
});

test('chat: auth headers + body forwarded on each provider', async () => {
  const cfg = makeCfg();
  const body = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  const resOr = await byId.openrouter.chat(cfg, { key: 'or-key-1' }, body);
  assert.equal(resOr.status, 200);
  const resGq = await byId.groq.chat(cfg, { key: 'gq-key-1' }, body);
  assert.equal(resGq.status, 200);
  const resGm = await byId.gemini.chat(cfg, { key: 'gm-key-1' }, body);
  assert.equal(resGm.status, 200);

  assert.equal(seen.or[0].auth, 'Bearer or-key-1');
  assert.equal(seen.groq[0].auth, 'Bearer gq-key-1');
  assert.equal(seen.gemini[0].auth, 'Bearer gm-key-1');
  assert.equal(seen.gemini[0].goog, 'gm-key-1');
  assert.equal(seen.or[0].body.model, 'x');
});

test('classifyError maps provider statuses to engine kinds', () => {
  for (const p of [byId.openrouter, byId.groq, byId.gemini]) {
    assert.equal(p.classifyError(402, ''), 'billing', p.id);
    assert.equal(p.classifyError(401, ''), 'auth', p.id);
    assert.equal(p.classifyError(429, ''), 'ratelimit', p.id);
    assert.equal(p.classifyError(410, ''), 'deprecated', p.id);
    assert.equal(p.classifyError(404, ''), 'notfound', p.id);
    assert.equal(p.classifyError(503, ''), 'transient', p.id);
    assert.equal(p.classifyError(299, ''), 'unknown', p.id);
  }
  assert.equal(byId.gemini.classifyError(429, 'RESOURCE_EXHAUSTED quota exceeded'), 'ratelimit');
});

test('catalog: pool=all surfaces every keyed model; pool=free filters to free-only', async () => {
  const cfg = makeCfg();
  for (const id of Object.keys(getCatalog().demoted)) reinstate(id);
  await refresh(cfg);
  let ids = getCatalog().models.map((m) => m.id).sort();
  assert.deepEqual(ids, ['gemini-2.0-flash', 'llama-3.3-70b-versatile', 'org/free-a:free', 'org/paid-b', 'org/stealth-c', 'qwen-qwq-32b'],
    'pool=all (default): paid model enters the pool — runtime billing demotion is the safety net');
  const paid = getCatalog().models.find((m) => m.id === 'org/paid-b');
  assert.deepEqual(paid.sources, [], 'paid model carries no free-source tags (dashboard shows unverified)');
  const freeA = getCatalog().models.find((m) => m.id === 'org/free-a:free');
  assert.ok(freeA.sources.length > 0, 'free model keeps its free-source tags');
  cfg.selection.pool = 'free';
  await refresh(cfg);
  ids = getCatalog().models.map((m) => m.id).sort();
  assert.deepEqual(ids, ['gemini-2.0-flash', 'llama-3.3-70b-versatile', 'org/free-a:free', 'org/stealth-c', 'qwen-qwq-32b'],
    'pool=free: paid model excluded');
  assert.equal(ids.includes('org/paid-b'), false, 'pool=free must never surface a paid model');
  const providers = new Set(getCatalog().models.map((m) => m.provider));
  assert.deepEqual([...providers].sort(), ['gemini', 'groq', 'openrouter']);
  cfg.selection.pool = undefined;
});

test('selection.pool: only all|free valid; missing defaults to all', () => {
  const cfg = makeCfg();
  assert.equal(cfg.selection.pool, undefined, 'makeCfg leaves pool unset (engine default all)');
  cfg.selection.pool = 'free';
  validateConfig(cfg);
  cfg.selection.pool = 'all';
  validateConfig(cfg);
  cfg.selection.pool = 'sometimes';
  assert.throws(() => validateConfig(cfg), /selection\.pool/);
  cfg.selection.pool = 1;
  assert.throws(() => validateConfig(cfg), /selection\.pool/);
});

test('catalog: credential-less providers are skipped (no keyless listing, no 401 spam)', async () => {
  const cfg = makeCfg();
  cfg.providers.openrouter.keys = [];
  cfg.providers.groq.keys = [];
  cfg.providers.gemini.keys = [];
  await refresh(cfg);
  assert.equal(getCatalog().models.length, 0, 'empty catalog when no provider has credentials');
  assert.equal(getCatalog().errors.length, 0, 'no refresh errors — providers skipped before listing');
});

test('factory presets: keyed list, chat auth, free-tier tag, catalog wiring', async () => {
  const seenCb = [];
  let listAuth = null;
  const cbMock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        listAuth = req.headers.authorization ?? null;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b' }, { id: 'qwen-3-235b' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seenCb.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
  try {
    const cfg = makeCfg();
    cfg.providers.cerebras = { enabled: true, keys: ['cb-key-1'], baseUrl: `http://127.0.0.1:${cbMock.port}` };
    validateConfig(cfg);

    const ids = await byId.cerebras.listModelIds(cfg);
    assert.deepEqual(ids, ['llama-3.3-70b', 'qwen-3-235b']);
    assert.equal(listAuth, 'Bearer cb-key-1', 'factory listing authenticates with the stored key');
    assert.deepEqual(byId.cerebras.freeSources('llama-3.3-70b', null), ['free-tier']);

    const res = await byId.cerebras.chat(cfg, { key: 'cb-key-1' }, { model: 'llama-3.3-70b', messages: [] });
    assert.equal(res.status, 200);
    assert.equal(seenCb[0].auth, 'Bearer cb-key-1');

    for (const id of Object.keys(getCatalog().demoted)) reinstate(id);
    await refresh(cfg);
    const row = getCatalog().models.find((m) => m.id === 'llama-3.3-70b');
    assert.equal(row?.provider, 'cerebras', 'preset models enter the catalog through the registry');

    assert.equal(byId.cerebras.classifyError(402, ''), 'billing');
    assert.equal(byId.mistral.defaultBase, 'https://api.mistral.ai/v1');
    assert.equal(byId.sambanova.defaultBase, 'https://api.sambanova.ai/v1');
    assert.equal(byId.sambanova.isEnabled(cfg), false, 'preset without a config block stays idle');
    cfg.providers.cerebras.baseUrl = '';
  } finally { await cbMock.close(); }
});

test('kilo: :free suffix is free-source, anonymous chat sends no Authorization header', async () => {
  const seen = [];
  const mock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'z-ai/glm-5:free' },
          { id: 'minimax/minimax-m2.1:free' },
          { id: 'anthropic/claude-sonnet-4.6' },
        ] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
  try {
    const cfg = makeCfg();
    cfg.providers.kilo = { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.port}` };
    validateConfig(cfg);

    const ids = await byId.kilo.listModelIds(cfg);
    assert.deepEqual(ids, ['z-ai/glm-5:free', 'minimax/minimax-m2.1:free', 'anthropic/claude-sonnet-4.6']);

    assert.deepEqual(byId.kilo.freeSources('z-ai/glm-5:free', null), ['suffix']);
    assert.deepEqual(byId.kilo.freeSources('anthropic/claude-sonnet-4.6', null), []);

    const creds = byId.kilo.listCredentials(cfg);
    assert.ok(creds.some((c) => c.label === 'anonymous' && c.key === '' && c.source === 'anonymous'));

    // Anonymous → no Authorization header
    const resAnon = await byId.kilo.chat(cfg, creds.find((c) => c.label === 'anonymous'), { model: 'z-ai/glm-5:free', messages: [] });
    assert.equal(resAnon.status, 200);
    assert.equal(seen[0].auth, undefined, 'anonymous kilo chat sends no Authorization header');

    // Keyed → Bearer header
    const resKeyed = await byId.kilo.chat(cfg, { key: 'kilo-key-1' }, { model: 'anthropic/claude-sonnet-4.6', messages: [] });
    assert.equal(resKeyed.status, 200);
    assert.equal(seen[1].auth, 'Bearer kilo-key-1');
  } finally { await mock.close(); }
});

test('ovh: anon-tier free-source for all models, anonymous chat sends no Authorization header', async () => {
  const seen = [];
  const mock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'Meta-Llama-3_3-70B-Instruct' },
          { id: 'gpt-oss-120b' },
        ] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
  try {
    const cfg = makeCfg();
    cfg.providers.ovh = { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.port}` };
    validateConfig(cfg);

    const ids = await byId.ovh.listModelIds(cfg);
    assert.deepEqual(ids, ['Meta-Llama-3_3-70B-Instruct', 'gpt-oss-120b']);

    assert.deepEqual(byId.ovh.freeSources('Meta-Llama-3_3-70B-Instruct', null), ['anon-tier']);
    assert.deepEqual(byId.ovh.freeSources('gpt-oss-120b', null), ['anon-tier']);

    const creds = byId.ovh.listCredentials(cfg);
    assert.ok(creds.some((c) => c.label === 'anonymous' && c.key === '' && c.source === 'anonymous'));

    const res = await byId.ovh.chat(cfg, creds.find((c) => c.label === 'anonymous'), { model: 'gpt-oss-120b', messages: [] });
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, undefined, 'anonymous ovh chat sends no Authorization header');
  } finally { await mock.close(); }
});

test('llm7: free-tier source for all models, anonymous chat sends Bearer unused', async () => {
  const seen = [];
  const mock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'gpt-oss' },
          { id: 'gpt-oss-120b' },
          { id: 'DeepSeek-V4-Flash-0731' },
        ] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
  try {
    const cfg = makeCfg();
    cfg.providers.llm7 = { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.port}` };
    validateConfig(cfg);

    const ids = await byId.llm7.listModelIds(cfg);
    assert.deepEqual(ids, ['gpt-oss', 'gpt-oss-120b', 'DeepSeek-V4-Flash-0731']);

    for (const m of ids) {
      assert.deepEqual(byId.llm7.freeSources(m, null), ['free-tier'], `${m} is free-tier`);
    }

    const creds = byId.llm7.listCredentials(cfg);
    assert.ok(creds.some((c) => c.label === 'anonymous' && c.key === 'unused' && c.source === 'anonymous'));

    const res = await byId.llm7.chat(cfg, creds.find((c) => c.label === 'anonymous'), { model: 'gpt-oss', messages: [] });
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer unused', 'anonymous llm7 chat sends placeholder bearer');
  } finally { await mock.close(); }
});

test('zai: key-required, free-source tags for flash/4.x models, Bearer auth', async () => {
  const seen = [];
  const mock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'glm-5.3' },
          { id: 'glm-5.3-flash' },
          { id: 'glm-4.7-flash' },
          { id: 'glm-4.6v-flash' },
          { id: 'glm-5-turbo' },
        ] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
  try {
    const cfg = makeCfg();
    cfg.providers.zai = { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.port}` };
    validateConfig(cfg);

    // No keys → no credentials → catalog skips zai (key required, no anonymous lane)
    assert.equal(byId.zai.listCredentials(cfg).length, 0);

    const ids = await byId.zai.listModelIds(cfg);
    assert.deepEqual(ids, ['glm-5.3', 'glm-5.3-flash', 'glm-4.7-flash', 'glm-4.6v-flash', 'glm-5-turbo']);

    assert.deepEqual(byId.zai.freeSources('glm-5.3-flash', null), ['suffix']);
    assert.deepEqual(byId.zai.freeSources('glm-4.7-flash', null), ['suffix', 'known-free']);
    assert.deepEqual(byId.zai.freeSources('glm-4.6v-flash', null), ['suffix', 'known-free']);
    assert.deepEqual(byId.zai.freeSources('glm-5-turbo', null), ['suffix', 'known-free']);
    assert.deepEqual(byId.zai.freeSources('glm-5.3', null), []);

    // Keyed → Bearer header sent upstream
    const res = await byId.zai.chat(cfg, { key: 'zai-key-1' }, { model: 'glm-4.7-flash', messages: [] });
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer zai-key-1');
    assert.equal(seen[0].body.model, 'glm-4.7-flash');
  } finally { await mock.close(); }
});

test('nvidia: key-required, models.dev free tag, Bearer auth', async () => {
  const seen = [];
  const mock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'meta/llama-3.1-70b-instruct' }, { id: 'nvidia/nemotron-4' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
  try {
    const cfg = makeCfg();
    cfg.providers.nvidia = { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.port}` };
    validateConfig(cfg);

    assert.equal(byId.nvidia.listCredentials(cfg).length, 0);
    const ids = await byId.nvidia.listModelIds(cfg);
    assert.deepEqual(ids, ['meta/llama-3.1-70b-instruct', 'nvidia/nemotron-4']);
    assert.deepEqual(byId.nvidia.freeSources('meta/llama-3.1-70b-instruct', null), []);
    assert.deepEqual(byId.nvidia.freeSources('nvidia/nemotron-4', { 'nvidia/nemotron-4': true }), ['models.dev']);

    const res = await byId.nvidia.chat(cfg, { key: 'nvidia-key-1' }, { model: 'nvidia/nemotron-4', messages: [] });
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer nvidia-key-1');
  } finally { await mock.close(); }
});

test('qwen: key-required, models.dev free tag, Bearer auth', async () => {
  const seen = [];
  const mock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'qwen-turbo' }, { id: 'qwen-max' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
  try {
    const cfg = makeCfg();
    cfg.providers.qwen = { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.port}` };
    validateConfig(cfg);

    assert.equal(byId.qwen.listCredentials(cfg).length, 0);
    const ids = await byId.qwen.listModelIds(cfg);
    assert.deepEqual(ids, ['qwen-turbo', 'qwen-max']);
    assert.deepEqual(byId.qwen.freeSources('qwen-turbo', null), []);
    assert.deepEqual(byId.qwen.freeSources('qwen-max', { 'qwen-max': true }), ['models.dev']);

    const res = await byId.qwen.chat(cfg, { key: 'qwen-key-1' }, { model: 'qwen-turbo', messages: [] });
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer qwen-key-1');
  } finally { await mock.close(); }
});

test('kluster: key-required, models.dev free tag, Bearer auth', async () => {
  const seen = [];
  const mock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'klusterai/Meta-Llama-3.1-405B-Instruct-Turbo' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
  try {
    const cfg = makeCfg();
    cfg.providers.kluster = { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.port}` };
    validateConfig(cfg);

    assert.equal(byId.kluster.listCredentials(cfg).length, 0);
    const ids = await byId.kluster.listModelIds(cfg);
    assert.deepEqual(ids, ['klusterai/Meta-Llama-3.1-405B-Instruct-Turbo']);
    assert.deepEqual(byId.kluster.freeSources('klusterai/Meta-Llama-3.1-405B-Instruct-Turbo', null), []);

    const res = await byId.kluster.chat(cfg, { key: 'kluster-key-1' }, { model: 'klusterai/Meta-Llama-3.1-405B-Instruct-Turbo', messages: [] });
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer kluster-key-1');
  } finally { await mock.close(); }
});

test('huggingface: key-required, models.dev free tag, Bearer auth', async () => {
  const seen = [];
  const mock = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'meta-llama/Llama-3.1-8B-Instruct' }] }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return sseOk(JSON.parse(raw).model, res);
      }
      res.writeHead(404); res.end();
    });
  });
  try {
    const cfg = makeCfg();
    cfg.providers.huggingface = { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.port}` };
    validateConfig(cfg);

    assert.equal(byId.huggingface.listCredentials(cfg).length, 0);
    const ids = await byId.huggingface.listModelIds(cfg);
    assert.deepEqual(ids, ['meta-llama/Llama-3.1-8B-Instruct']);
    assert.deepEqual(byId.huggingface.freeSources('meta-llama/Llama-3.1-8B-Instruct', null), []);

    const res = await byId.huggingface.chat(cfg, { key: 'hf-token-1' }, { model: 'meta-llama/Llama-3.1-8B-Instruct', messages: [] });
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer hf-token-1');
  } finally { await mock.close(); }
});

test('teardown', async () => {
  for (const m of [orMock, groqMock, geminiMock]) if (m) await m.close();
});
