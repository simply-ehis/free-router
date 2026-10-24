// @body:organ=muscle type=test role="free providers: modality filtering from real-shaped catalogs, 429 is 'limited' not failing, soft demotions heal, background-check budgets, verify endpoint logic"
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FREE_ROUTER_CONFIG = path.join(mkdtempSync(path.join(os.tmpdir(), 'fr-free-')), 'config.json');

const { validateConfig } = await import('../src/config.mjs');
const { refresh, getState, reinstate } = await import('../src/catalog.mjs');
const { verifyModels, getProbeState } = await import('../src/probe.mjs');
const { resetState } = await import('../src/routes.mjs');
const { classifyModel } = await import('../src/modality.mjs');
const { healthOf } = await import('../src/dashboardStatus.mjs');
const { takePing, resetPingBudget, laneInfo } = await import('../src/freeLanes.mjs');
const { PROBE_STATE_PATH, parseProbeState } = await import('../src/probeStore.mjs');
const { store } = await import('../src/store.mjs');

// ---- realistic catalog shapes -------------------------------------------------
const OVH_STYLE = [
  'Meta-Llama-3_3-70B-Instruct', 'Mistral-Small-3.2-24B-Instruct-2506', 'Qwen3-32B', 'Qwen3-Coder-30B-A3B-Instruct', 'gpt-oss-120b', 'gpt-oss-20b',
  'DeepSeek-R1-Distill-Llama-70B', 'Qwen2.5-VL-72B-Instruct', 'llava-next-mistral-7b',
];
const OVH_NON_CHAT = ['bge-m3', 'bge-base-en-v1.5', 'whisper-large-v3-turbo', 'nvr-asr-en-gb', 'nvr-tts-en-us', 'stable-diffusion-xl'];
const LLM7_STYLE = ['gpt-oss-20b', 'deepseek-r1-0528', 'codestral-2501', 'mistral-small-3.1-24b-instruct-2503', 'GLM-4.6V-Flash', 'ministral-8b-2410', 'gemini-2.5-flash-lite'];

test('classifier: free-provider chat catalogs stay chat, their embedding/ASR/TTS/image models do not', () => {
  for (const id of [...OVH_STYLE, ...LLM7_STYLE]) assert.equal(classifyModel(id).chat, true, `${id} must stay routable`);
  for (const id of OVH_NON_CHAT) assert.equal(classifyModel(id).chat, false, `${id} must be filtered`);
});

test('classifier: video models are filtered however the provider names them', () => {
  for (const id of ['veo-3.0-generate-001', 'wan2.2-t2v-a14b', 'Wan-AI/Wan2.1-T2V-14B', 'kling-v2-master', 'hunyuanvideo', 'cogvideox-5b', 'seedance-1-0-lite', 'minimax/hailuo-02', 'sora-2', 'ltx-video', 'mochi-1']) {
    assert.equal(classifyModel(id).kind, 'video', id);
  }
});

// ---- mock free provider (OVH-shaped, keyless) ---------------------------------
let mock;
const chatBehavior = new Map(); // model -> { status, body? }
const listing = [
  ...OVH_STYLE.map((id) => ({ id, object: 'model' })),
  ...OVH_NON_CHAT.map((id) => ({ id, object: 'model' })),
  { id: 'opaque-name-7b', object: 'model', architecture: { output_modalities: ['image'] } },
  { id: 'veo-3-fast', object: 'model' },
];

function sse(model) {
  const c = [
    { id: 'c', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { id: 'c', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return c.map((x) => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n';
}

test.before(async () => {
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: listing }));
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        const model = JSON.parse(raw).model;
        const b = chatBehavior.get(model);
        if (b) { res.writeHead(b.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: b.message ?? 'nope' } })); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(sse(model));
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
});
test.after(() => new Promise((r) => mock.close(r)));

function makeCfg(over = {}) {
  const cfg = {
    name: 'test', dashboardPassword: 'a-long-test-password', host: '127.0.0.1', port: 41420, autoDiscover: false,
    selection: { strategy: 'sticky', pool: 'free', weights: {}, timeboxMs: 80, attemptTimeoutMs: 2000, forceChat: [], blacklist: [] },
    providers: {
      zen: { enabled: false, keys: [], importOpencodeAuth: false, baseUrl: '' },
      ovh: { enabled: true, keys: [], baseUrl: `http://127.0.0.1:${mock.address().port}` },
    },
    probe: { intervalMs: 12000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
    ...over,
  };
  validateConfig(cfg);
  return cfg;
}

test.beforeEach(() => { resetState(); resetPingBudget(); chatBehavior.clear(); for (const id of Object.keys(getState().demoted)) reinstate(id); });

test('catalog: only chat models enter the pool; the rest are listed with a reason', async () => {
  await refresh(makeCfg());
  const ids = getState().models.map((m) => m.id).sort();
  assert.deepEqual(ids, [...OVH_STYLE].sort());
  const filtered = Object.fromEntries(getState().filtered.map((f) => [f.id, f]));
  for (const id of [...OVH_NON_CHAT, 'opaque-name-7b', 'veo-3-fast']) assert.ok(filtered[id], `${id} should be listed as filtered`);
  assert.equal(filtered['opaque-name-7b'].kind, 'image', 'provider metadata beats an opaque name');
  assert.equal(filtered['veo-3-fast'].kind, 'video');
  assert.match(filtered['bge-m3'].reason, /embedding/);
});

test('forceChat: a filtered model can be let back in by the owner', async () => {
  await refresh(makeCfg({ selection: { strategy: 'sticky', pool: 'free', weights: {}, timeboxMs: 80, attemptTimeoutMs: 2000, forceChat: ['veo-3-fast'], blacklist: [] } }));
  assert.ok(getState().models.some((m) => m.id === 'veo-3-fast'));
  assert.ok(!getState().filtered.some((f) => f.id === 'veo-3-fast'));
});

test('verify: 429 on a free tier is "limited" — it must not read as failing or hit the failure strip', async () => {
  const cfg = makeCfg();
  await refresh(cfg);
  chatBehavior.set('Qwen3-32B', { status: 429, message: 'rate limit exceeded' });
  const [r] = await verifyModels(cfg, ['Qwen3-32B']);
  assert.equal(r.ok, false);
  assert.equal(r.limited, true);
  const probe = getProbeState()['Qwen3-32B'];
  assert.equal(probe.lastErr, null, '429 is not recorded as an error');
  assert.ok(probe.lastLimited > 0);
  assert.equal(healthOf({ consecutiveFails: 0, recent: [] }, probe), 'limited');
  assert.ok(getState().models.some((m) => m.id === 'Qwen3-32B'), 'still in the pool');
});

test('verify: success marks working; a later real failure marks failing', async () => {
  const cfg = makeCfg();
  await refresh(cfg);
  await verifyModels(cfg, ['gpt-oss-20b']);
  assert.equal(healthOf({ consecutiveFails: 0 }, getProbeState()['gpt-oss-20b']), 'working');
  chatBehavior.set('gpt-oss-20b', { status: 500, message: 'boom' });
  await verifyModels(cfg, ['gpt-oss-20b']);
  assert.equal(healthOf({ consecutiveFails: 0 }, getProbeState()['gpt-oss-20b']), 'failing');
  assert.equal(healthOf({}, undefined), 'untested');
});

test('verdicts: a 400 never demotes; a 404 demotes only temporarily; billing stays out until reinstated', async () => {
  const cfg = makeCfg();
  await refresh(cfg);
  chatBehavior.set('Qwen3-32B', { status: 400, message: 'bad request body' });
  chatBehavior.set('gpt-oss-120b', { status: 404, message: 'no such model' });
  chatBehavior.set('gpt-oss-20b', { status: 402, message: 'insufficient balance' });
  await verifyModels(cfg, ['Qwen3-32B', 'gpt-oss-120b', 'gpt-oss-20b']);
  const demoted = getState().demoted;
  assert.equal(demoted['Qwen3-32B'], undefined, '400 is not a death sentence');
  assert.ok(demoted['gpt-oss-120b'].until > Date.now(), '404 → temporary');
  assert.equal(demoted['gpt-oss-20b'].until, undefined, 'billing → until manual reinstate');
});

test('verdicts: 401/403 on the anonymous lane means "needs a token" (temporary); the same on your own key never demotes', async () => {
  const anon = makeCfg();
  await refresh(anon);
  chatBehavior.set('Qwen3-32B', { status: 403, message: 'forbidden' });
  await verifyModels(anon, ['Qwen3-32B']);
  assert.match(getState().demoted['Qwen3-32B']?.reason ?? '', /needs-token/);
  reinstate('Qwen3-32B');
  const keyed = makeCfg({ providers: { zen: { enabled: false, keys: [], importOpencodeAuth: false, baseUrl: '' }, ovh: { enabled: true, keys: ['ovh-token-1'], baseUrl: `http://127.0.0.1:${mock.address().port}` } } });
  await refresh(keyed);
  await verifyModels(keyed, ['Qwen3-32B']);
  assert.equal(getState().demoted['Qwen3-32B'], undefined, 'a bad/rotated key must not wipe models out of the pool');
});

test('soft demotions expire on the next refresh', async () => {
  const cfg = makeCfg();
  await refresh(cfg);
  const { demote } = await import('../src/catalog.mjs');
  demote('Qwen3-32B', 'test-soft', { ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  await refresh(cfg);
  assert.ok(getState().models.some((m) => m.id === 'Qwen3-32B'));
  assert.equal(getState().demoted['Qwen3-32B'], undefined);
});

test('background-check budget: keyless lanes cap pings per hour, manual checks bypass the cap', () => {
  const cap = laneInfo('kilo').pingsPerHour;
  let granted = 0;
  for (let i = 0; i < cap + 10; i += 1) if (takePing('kilo')) granted += 1;
  assert.equal(granted, cap);
  assert.equal(takePing('kilo'), false);
  assert.equal(takePing('kilo', { force: true }), true, 'manual verify always runs');
  assert.equal(takePing('ovh'), true, 'budgets are per provider');
  assert.equal(laneInfo('ovh').keyless, true);
  assert.equal(laneInfo('groq').keyless, false);
});

test('verify only tests models that are in the pool and caps the batch', async () => {
  const cfg = makeCfg();
  await refresh(cfg);
  const results = await verifyModels(cfg, ['not-a-model', 'bge-m3', ...OVH_STYLE], { max: 4 });
  assert.equal(results.length <= 4, true);
  assert.ok(results.every((r) => OVH_STYLE.includes(r.id)));
});

test('verify results are saved, so a restart (or a recycled Worker isolate) still knows which models work', async () => {
  const cfg = makeCfg();
  await refresh(cfg);
  chatBehavior.set('Qwen3-32B', { status: 500, message: 'boom' });
  await verifyModels(cfg, ['gpt-oss-20b', 'Qwen3-32B']);
  const saved = parseProbeState(store.read(PROBE_STATE_PATH));
  assert.ok(saved.get('gpt-oss-20b').lastOk > 0, 'a working model is saved as working');
  assert.equal(saved.get('Qwen3-32B').lastErr?.kind, 'transient', 'a failing model is saved as failing');
  assert.equal(healthOf({ consecutiveFails: 0 }, saved.get('gpt-oss-20b')), 'working');
  assert.equal(healthOf({ consecutiveFails: 0 }, saved.get('Qwen3-32B')), 'failing');
});
