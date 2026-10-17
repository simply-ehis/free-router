import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
const auth = { authorization: `Bearer ${cfg.apiKey}` };

// 1) /v1/decide passthrough to real keyless jev
const t0 = Date.now();
const decideRes = await fetch('http://127.0.0.1:4141/v1/decide', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({
    state: 'My payments have failed for three days and I am losing sales. Please help now.',
    questions: { is_urgent: { type: 'noul', instructions: 'Does this request require urgent attention?' } },
  }),
});
const decideBody = await decideRes.json();
console.log('decide status:', decideRes.status, `(${Date.now() - t0}ms)`);
console.log('decide answers:', JSON.stringify(decideBody.answers));
console.log('decide model:', decideBody.model);

// 2) invalid body → 400
const bad = await fetch('http://127.0.0.1:4141/v1/decide', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ state: 'x', questions: [] }),
});
console.log('decide invalid →', bad.status);

// 3) non-stream chat with classify+rankHints active in background (decision plane on)
const t1 = Date.now();
const chatRes = await fetch('http://127.0.0.1:4141/v1/chat/completions', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'Say OK and nothing else.' }] }),
});
const chatBody = await chatRes.json();
console.log('chat status:', chatRes.status, `(${Date.now() - t1}ms)`, '| model:', chatBody.model);
console.log('chat content:', chatBody.choices?.[0]?.message?.content?.slice(0, 80));
