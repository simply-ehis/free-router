import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
const r = await fetch('http://127.0.0.1:4141/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
  body: JSON.stringify({ model: 'claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'Count from 1 to 3, one number per word.' }] }),
});
console.log('status', r.status, '| content-type:', r.headers.get('content-type'));
const reader = r.body.getReader();
const dec = new TextDecoder();
let first = '';
let all = '';
let chunks = 0;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks += 1;
  const s = dec.decode(value, { stream: true });
  all += s;
  if (!first) first = s.slice(0, 220);
}
console.log('sse chunks:', chunks);
console.log('FIRST:', first.replace(/\n/g, ' ~ '));
console.log('HAS DONE:', all.includes('data: [DONE]'));
const m = all.match(/"model":"([^"]+)"/);
console.log('model:', m ? m[1] : '?');
const texts = [...all.matchAll(/"content":"([^"]+)"/g)].map((x) => x[1]).join('');
console.log('streamed text:', texts.slice(0, 160));
