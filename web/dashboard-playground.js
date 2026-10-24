/* PURPOSE: Dashboard playground — talk to models through the router from the dashboard. Served at /dashboard-playground.js */
/* OWNS: everything behind the playground tab (transcript, model picker, streaming client, composer) */
/* READ-WHEN: editing the playground; shared helpers ($/api/esc/log/fail/lock/onSnapshot) come from dashboard.js */
/* KEY-FILES: web/dashboard.html (DOM ids), web/dashboard.js (helpers/snapshot hooks), src/playground.mjs (endpoint) */
/* INVARIANTS: zero deps; model output rendered via textContent only (never HTML); conversation state is client-side, never persisted server-side */
/* GOTCHAS: dashboard.js is the loader — do not redeclare its globals; SSE parsing needs a carry buffer across reads; send disabled while busy */
/* UPDATED: 2026-10-14 */
'use strict';

const pgMessages = []; // conversation state re-sent with each request
let pgAbort = null;
let pgBusy = false;

// ---------- transcript ----------
function pgScrollToEnd() {
  const box = $('pgChat');
  box.scrollTop = box.scrollHeight;
}

function pgBubble(kind, text) {
  const el = document.createElement('div');
  el.className = 'bubble ' + kind;
  const body = document.createElement('div');
  body.className = 'bubble-text';
  body.textContent = text; // model output is untrusted — textContent, never innerHTML
  el.appendChild(body);
  $('pgChat').appendChild(el);
  pgScrollToEnd();
  return el;
}

function pgMeta(el, meta) {
  const m = document.createElement('div');
  m.className = 'bubble-meta';
  m.textContent = meta;
  el.appendChild(m);
  pgScrollToEnd();
}

// ---------- request/response ----------
function pgRequestBody() {
  const messages = pgMessages.slice();
  const system = $('pgSystem').value.trim();
  if (system) messages.unshift({ role: 'system', content: system });
  const body = { messages, stream: $('pgStream').checked };
  const model = $('pgModel').value;
  if (model && model !== 'auto') body.model = model;
  const temp = Number($('pgTemp').value);
  if (Number.isFinite(temp) && temp >= 0 && temp <= 2) body.temperature = temp;
  const max = Number($('pgMaxTokens').value);
  if (Number.isInteger(max) && max > 0) body.maxTokens = max;
  return body;
}

async function pgReply() {
  const started = Date.now();
  const out = await api('/api/playground', { method: 'POST', body: JSON.stringify(pgRequestBody()) });
  const bubble = pgBubble('assistant', out.reply || '(empty reply)');
  pgMessages.push({ role: 'assistant', content: out.reply || '' });
  const tokens = out.tokensOut ? ` · tokens ${out.tokensIn ?? '?'}/${out.tokensOut}` : '';
  const compacted = out.compacted ? ` · compacted (${out.compacted.mode}, -${out.compacted.dropped})` : '';
  pgMeta(bubble, `${out.model} · ${out.provider} · ${out.ms} ms · attempts ${out.attempts}${tokens}${compacted}`);
}

// Incremental SSE parse: chunks rarely align with event boundaries, so the
// tail stays buffered until the next read completes the event.
async function pgStreamReply() {
  pgAbort = new AbortController();
  const started = Date.now();
  const res = await fetch('/api/playground', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(pgRequestBody()),
    signal: pgAbort.signal,
  });
  if (res.status === 401) { showLogin('Your session ended. Sign in again.'); throw new Error('Sign in required'); }
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b?.error?.message || 'HTTP ' + res.status);
  }
  const model = decodeURIComponent(res.headers.get('x-router-model') || 'unknown');
  const provider = decodeURIComponent(res.headers.get('x-router-provider') || '');
  const attempts = res.headers.get('x-router-attempts') || '1';
  const bubble = pgBubble('assistant', '');
  const textEl = bubble.querySelector('.bubble-text');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let full = '';
  let stopped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      const events = carry.split('\n\n');
      carry = events.pop();
      for (const evt of events) {
        for (const line of evt.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) { full += delta; textEl.textContent = full; pgScrollToEnd(); }
          } catch { /* malformed chunk must not kill the stream */ }
        }
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') throw err;
    stopped = true;
  }
  textEl.textContent = full || (stopped ? '⏹ stopped before any text' : '(empty reply)');
  pgMessages.push({ role: 'assistant', content: full });
  pgMeta(bubble, `${model} · ${provider} · ${Date.now() - started} ms · attempts ${attempts}${stopped ? ' · stopped by you' : ''}`);
}

// ---------- flow ----------
function pgSetBusy(busy) {
  pgBusy = busy;
  $('pgSend').disabled = busy;
  $('pgInput').disabled = busy;
  $('pgStop').classList.toggle('hidden', !busy);
  $('pgRegen').classList.toggle('hidden', busy || pgMessages.at(-1)?.role !== 'assistant');
}

async function pgRun() {
  pgSetBusy(true);
  try {
    if ($('pgStream').checked) await pgStreamReply();
    else await pgReply();
  } catch (err) {
    if (err?.name !== 'AbortError') pgBubble('error', 'error → ' + (err?.message || err));
  } finally {
    pgSetBusy(false);
    pgAbort = null;
  }
}

async function pgSend() {
  const text = $('pgInput').value.trim();
  if (!text || pgBusy) return;
  $('pgInput').value = '';
  pgMessages.push({ role: 'user', content: text });
  pgBubble('user', text);
  await pgRun();
}

async function pgRegenerate() {
  if (pgBusy) return;
  while (pgMessages.length && pgMessages.at(-1).role === 'assistant') {
    pgMessages.pop();
    $('pgChat').lastElementChild?.remove();
  }
  if (pgMessages.at(-1)?.role !== 'user') return;
  await pgRun();
}

// ---------- wiring ----------
$('pgSend').onclick = pgSend;
$('pgStop').onclick = () => pgAbort?.abort();
$('pgRegen').onclick = pgRegenerate;
$('pgClear').onclick = () => {
  if (pgBusy) pgAbort?.abort();
  pgMessages.length = 0;
  $('pgChat').innerHTML = '';
  $('pgRegen').classList.add('hidden');
};
$('pgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pgSend(); } });
onSnapshot((s) => {
  const sel = $('pgModel');
  const ids = [...new Set((s.modelsDetail || []).map((m) => m.id))].sort();
  const sig = ids.join(',');
  if (sel.dataset.sig !== sig) {
    const current = sel.value || 'auto';
    sel.innerHTML = '<option value="auto">auto — router decides</option>' + ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
    sel.dataset.sig = sig;
    sel.value = ids.includes(current) ? current : 'auto';
  }
});
