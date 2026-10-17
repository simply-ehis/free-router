// Zen free-tier gate (2026-10-14 revision): the exact fingerprint the upstream
// inspects. The gate 403s (FreeTierError) on any deviation — no mock can reveal
// that, so these assertions are the mutation guard for the disguise.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { byId } from '../src/providers/index.mjs';

const zen = byId.zen;

// Mirrors the upstream's live-verified session check: ses_ + 12 lowercase hex
// whose last 3 chars land in the fc0-fff descending-counter window + 14 base62.
const DESCENDING_SID = /^ses_[0-9a-f]{9}f[c-f][0-9a-f][0-9A-Za-z]{14}$/;

test('session id mints in the canonical descending layout', () => {
  assert.match(zen.rotateSession(), DESCENDING_SID);
  assert.match(zen.rotateSession(), DESCENDING_SID, 'fresh mint stays canonical');
});

test('anonymous lane is always the last credential (zero-config zen)', () => {
  const withKey = zen.listCredentials({
    providers: { zen: { enabled: true, importOpencodeAuth: false, keys: ['zk-real-key-0001'], baseUrl: '' } },
  });
  assert.equal(withKey.at(-1).label, 'anonymous');
  assert.equal(withKey.at(-1).key, 'public');
  assert.equal(withKey[0].label, 'zen-1', 'saved keys outrank the anonymous lane');
  const keyless = zen.listCredentials({
    providers: { zen: { enabled: true, importOpencodeAuth: false, keys: [], baseUrl: '' } },
  });
  assert.equal(keyless.length, 1, 'zen carries a credential even with zero keys');
});

test('ensureFreeTierBody streams, reports usage and injects the core tool names', () => {
  const clientTool = { type: 'function', function: { name: 'client-tool' } };
  const out = zen.ensureFreeTierBody({ model: 'x-free', messages: [], tools: [clientTool] });
  assert.equal(out.stream, true, 'free lane rejects non-streaming');
  assert.equal(out.stream_options.include_usage, true);
  for (const name of zen.gateTools) {
    assert.ok(out.tools.some((t) => t.function?.name === name), `gate tool ${name} present`);
  }
  assert.ok(out.tools.some((t) => t.function?.name === 'client-tool'), 'client tool preserved');
  const bare = zen.ensureFreeTierBody({ model: 'x-free', messages: [] });
  assert.equal(bare.tools.length, zen.gateTools.length, 'tool-less bodies get the full gate set');
});

test('chat sends the fingerprint the gate inspects', async () => {
  const seen = {};
  const mock = http.createServer((req, res) => {
    seen.headers = req.headers;
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {}\n\n');
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  try {
    const cfg = {
      providers: { zen: { enabled: true, importOpencodeAuth: false, keys: [], baseUrl: `http://127.0.0.1:${mock.address().port}` } },
    };
    const cred = zen.listCredentials(cfg).at(-1);
    const res = await zen.chat(cfg, cred, { model: 'x-free', messages: [] });
    await res.text();

    const h = seen.headers;
    assert.equal(h.authorization, 'Bearer public');
    assert.equal(h['user-agent'], 'opencode/latest/2.0.29/cli');
    assert.equal(h['x-opencode-client'], 'cli');
    assert.equal(h['x-opencode-project'], 'global');
    assert.match(h['x-opencode-session'], DESCENDING_SID);
    assert.equal(h['x-opencode-session-id'], h['x-opencode-session'], 'both session headers carry the same id');
    assert.equal(h['x-session-affinity'], h['x-opencode-session']);
    assert.equal(h['x-session-id'], h['x-opencode-session'], 'X-Session-Id mirrors the session');
    assert.equal(h['x-opencode-request'], undefined, 'x-opencode-request is rejected by the gate');
    assert.equal(seen.body.stream, true);
    assert.equal(seen.body.stream_options.include_usage, true);
  } finally {
    await new Promise((r) => mock.close(r));
  }
});
