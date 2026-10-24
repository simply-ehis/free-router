/* PURPOSE: Dashboard core — session login, live stream, snapshot dispatch, shell (tabs/theme/toast), overview page. Served at /dashboard.js */
/* OWNS: shared helpers ($, api, esc, setHtml, log, toast, fail, ago, strip, providerName, healthByProvider), tab shell, overview rendering, snapshot hooks */
/* READ-WHEN: editing dashboard behavior; page code lives in dashboard-{models,providers,security,playground,analytics,settings}.js */
/* KEY-FILES: web/dashboard.html (DOM), web/dashboard.css (styles), src/dashboard.mjs (API), src/dashboardStatus.mjs (snapshot shape) */
/* INVARIANTS: zero deps; every interpolation escaped with esc(); no secrets ever rendered; the dashboard password is NEVER stored in the page — the session is an HttpOnly cookie */
/* GOTCHAS: SSE snapshots arrive every 2s — render through setHtml() so unchanged markup is not rebuilt (keeps focus, scroll and open <details>); later script files are called only through typeof guards or onSnapshot(fn) hooks */
/* UPDATED: 2026-10-22 */
'use strict';
const $ = (id) => document.getElementById(id);
let es = null;
let lastSnapshot = null;
let activeTab = 'overview';

const TAB_TITLES = { overview: 'Overview', models: 'Models', providers: 'Providers', playground: 'Playground', analytics: 'Analytics', security: 'Security', settings: 'Settings' };
const STATUS_ORDER = ['working', 'limited', 'failing', 'cooldown', 'untested'];
const STATUS_LABEL = { working: 'Working', limited: 'Rate limited', failing: 'Failing', cooldown: 'Cooling down', untested: 'Not tested yet' };
const PROVIDER_NAMES = {
  zen: 'OpenCode Zen', openrouter: 'OpenRouter', groq: 'Groq', gemini: 'Google Gemini', cerebras: 'Cerebras', sambanova: 'SambaNova', mistral: 'Mistral',
  'openai-compat': 'Custom endpoints', kilo: 'Kilo Gateway', ovh: 'OVHcloud', llm7: 'LLM7', zai: 'Z.AI', nvidia: 'NVIDIA NIM', qwen: 'Qwen (DashScope)', kluster: 'Kluster.ai', huggingface: 'Hugging Face',
};
const providerName = (id) => PROVIDER_NAMES[id] || id;

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) { showLogin('Your session ended. Sign in again.'); throw new Error('Sign in required'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const wait = res.headers.get('retry-after');
    throw new Error((body?.error?.message || ('HTTP ' + res.status)) + (res.status === 429 && wait ? ` (try again in ${wait}s)` : ''));
  }
  return body;
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Assigns innerHTML only when the markup actually changed.
const lastHtml = new WeakMap();
function setHtml(el, html) {
  if (!el || lastHtml.get(el) === html) return false;
  lastHtml.set(el, html);
  el.innerHTML = html;
  return true;
}

function ago(ts) {
  if (!ts) return 'never';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} days ago`;
}

// Last 12 outcomes of a model: green tick = ok, red = failed, faint = no data yet.
function strip(recent) {
  const r = (recent || []).slice(-12);
  const ticks = [];
  for (let i = 0; i < 12 - r.length; i += 1) ticks.push('<i></i>');
  for (const v of r) ticks.push(`<i class="${v ? 'ok' : 'bad'}"></i>`);
  const bad = r.filter((v) => !v).length;
  const label = r.length ? `Last ${r.length} results: ${r.length - bad} ok, ${bad} failed` : 'No results yet';
  return `<span class="strip" role="img" aria-label="${label}" title="${label}">${ticks.join('')}</span>`;
}

function log(type, data) {
  const el = document.createElement('div');
  const t = new Date().toTimeString().slice(0, 8);
  if (type === 'route') {
    el.innerHTML = `<span class="t">${t}</span>request to <b>${esc(data.model)}</b> ${data.ok ? '<span class="badge ok">ok</span>' : '<span class="badge bad">failed</span>'} ${data.ms ?? ''}ms, attempts ${data.attempts ?? 1}${data.stream ? ', streamed' : ''}`;
  } else if (type === 'probe') {
    el.innerHTML = `<span class="t">${t}</span>check <b>${esc(data.model)}</b> ${data.ok ? '<span class="badge ok">ok</span>' : `<span class="badge bad">${esc(data.kind || 'failed')}</span>`}`;
  } else if (type === 'compaction') {
    el.innerHTML = `<span class="t">${t}</span>shortened chat for <b>${esc(data.model)}</b> <span class="badge">${esc(data.mode)}</span> dropped ${data.dropped}`;
  } else {
    el.innerHTML = `<span class="t">${t}</span><span class="muted">${esc(type)}</span>`;
  }
  const box = $('log');
  box.prepend(el);
  while (box.children.length > 80) box.lastChild.remove();
}

let toastTimer = null;
function toast(msg, kind) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3800);
}

// Remote-action failures need a visible surface — the activity feed alone is easy to miss.
function fail(err) {
  const msg = err?.message || String(err);
  if (msg === 'Sign in required') return;
  log('error: ' + msg);
  toast(msg, 'bad');
}

async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { toast('Copy failed. Select the text and copy it by hand.', 'bad'); return; }
  if (button) { const old = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = old; }, 1200); }
}

// ---------- per-provider rollups (shared by overview, models, providers) ----------
function healthByProvider(s) {
  const out = {};
  for (const m of s.modelsDetail || []) {
    const row = out[m.provider] || (out[m.provider] = { total: 0, working: 0, limited: 0, failing: 0, cooldown: 0, untested: 0 });
    row.total += 1;
    row[m.health] += 1;
  }
  return out;
}

function laneSummary(row) {
  if (!row || row.total === 0) return '<span class="muted">No models in the pool yet</span>';
  const bits = [];
  if (row.limited) bits.push(`${row.limited} rate limited`);
  if (row.failing + row.cooldown) bits.push(`${row.failing + row.cooldown} failing`);
  if (row.untested) bits.push(`${row.untested} not tested`);
  return `<span class="count">${row.working}</span> <span class="muted">working of ${row.total}${bits.length ? ', ' + bits.join(', ') : ''}</span>`;
}

// ---------- tabs ----------
function showTab(name, { keepHash = false } = {}) {
  if (!TAB_TITLES[name]) name = 'overview';
  activeTab = name;
  for (const btn of document.querySelectorAll('#tabs button[data-tab]')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
    if (btn.dataset.tab === name) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  }
  for (const page of document.querySelectorAll('section.page')) page.classList.toggle('active', page.dataset.page === name);
  $('pageTitle').textContent = TAB_TITLES[name];
  if (!keepHash) history.replaceState(null, '', '#' + name);
  if (name === 'analytics') {
    if (typeof loadUsage === 'function') loadUsage();
    if (typeof loadAudit === 'function') loadAudit();
  }
  if (name === 'settings' && typeof loadSettings === 'function') loadSettings();
  if (name === 'security' && typeof loadSecurity === 'function') loadSecurity();
  window.scrollTo(0, 0);
}

// Buttons anywhere can jump to a page, optionally pre-setting a models filter.
function go(tab, { status, provider } = {}) {
  if (tab === 'models' && typeof setModelFilter === 'function') setModelFilter({ status, provider });
  showTab(tab);
}

// ---------- theme ----------
const THEME_LABEL = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode; else delete document.documentElement.dataset.theme;
  $('themeBtn').textContent = THEME_LABEL[mode] || THEME_LABEL.system;
}
function currentTheme() { try { return localStorage.getItem('fr_theme') || 'system'; } catch { return 'system'; } }
$('themeBtn').onclick = () => {
  const next = { system: 'light', light: 'dark', dark: 'system' }[currentTheme()] || 'system';
  try { localStorage.setItem('fr_theme', next); } catch { /* private mode: theme just won't persist */ }
  applyTheme(next);
};
applyTheme(currentTheme());

// ---------- snapshot hooks (page files register extra render work) ----------
const snapshotHooks = [];
function onSnapshot(fn) { snapshotHooks.push(fn); }

// ---------- overview ----------
function renderOverview(s) {
  const h = s.health || {};
  const total = s.models.free;
  $('dot').classList.toggle('live', s.models.refreshOk);
  $('title').textContent = s.name || 'free-router';
  $('meta').textContent = `${s.strategy} routing, ${s.pool} pool`;
  $('poolMini').textContent = total ? `${h.working || 0} of ${total} working` : 'No models yet';

  $('poolHeadline').innerHTML = total
    ? `<b>${h.working || 0}</b> of ${total} models are working`
    : 'No models in the pool yet';
  const segs = STATUS_ORDER.filter((st) => h[st] > 0)
    .map((st, i) => `<button class="seg ${st}" style="flex:${h[st]};animation-delay:${i * 60}ms" data-go-status="${st}" title="${h[st]} ${STATUS_LABEL[st].toLowerCase()}" aria-label="${h[st]} ${STATUS_LABEL[st].toLowerCase()}. Show them."></button>`).join('');
  setHtml($('poolBar'), segs || '<div class="pulse empty"></div>');
  setHtml($('poolLegend'), STATUS_ORDER.filter((st) => h[st] > 0)
    .map((st) => `<button data-go-status="${st}"><span class="swatch ${st}"></span>${h[st]} ${STATUS_LABEL[st].toLowerCase()}</button>`).join(''));
  const parts = [];
  if (h.untested > 0) parts.push(`${h.untested} models have not been tested. Open Models and press Test shown models to check them.`);
  if (s.models.filtered > 0) parts.push(`${s.models.filtered} non-chat models (image, video, audio, embeddings) were kept out of the pool.`);
  if (s.catalogErrors?.length) parts.push(`Could not list models from ${s.catalogErrors.map((e) => providerName(e.provider)).join(', ')}.`);
  $('poolHelp').textContent = parts.join(' ');

  $('openaiEndpoint').textContent = location.origin + '/v1';
  $('anthropicEndpoint').textContent = location.origin + '/v1/messages';
  $('curlSample').textContent = `curl ${location.origin}/v1/chat/completions \\\n  -H "Authorization: Bearer <your client key>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Say hi"}]}'`;

  const sel = $('strategy');
  if (sel.dataset.init !== '1') {
    sel.innerHTML = ['sticky', 'fastest', 'roundrobin', 'smartest'].map((n) => `<option value="${n}">${n}</option>`).join('');
    sel.dataset.init = '1';
  }
  if (document.activeElement !== sel) sel.value = s.strategy;

  const byProv = healthByProvider(s);
  const lanes = (s.providers || []).filter((p) => p.lane?.keyless);
  setHtml($('freeLanes'), lanes.map((p) => laneCard(p, byProv[p.id], { actions: false })).join(''));
  const keyed = (s.providers || []).filter((p) => !p.lane?.keyless && p.id !== 'openai-compat');
  const active = keyed.filter((p) => p.enabled || p.keys > 0);
  const idle = keyed.filter((p) => !p.enabled && p.keys === 0);
  setHtml($('keyedSummary'), active.map((p) => laneCard(p, byProv[p.id], { actions: false })).join('')
    + (idle.length ? `<div class="notset" style="grid-column:1/-1"><span class="muted">Not set up yet: ${idle.map((p) => esc(providerName(p.id))).join(', ')}.</span><button data-go-tab="providers">Add keys</button></div>` : ''));
}

// One provider tile, used on Overview and Providers. `actions` adds buttons.
function laneCard(p, row, { actions }) {
  const off = !p.enabled;
  const badge = p.lane?.keyless ? '<span class="tag ok">no key needed</span>' : (p.keys > 0 ? `<span class="tag acc">${p.keys} key${p.keys === 1 ? '' : 's'}</span>` : '<span class="tag warn">needs a key</span>');
  const budget = p.lane?.keyless && p.enabled ? `<span class="muted">Checks this hour: ${p.lane.checksThisHour}. Background checks pause at ${p.lane.checksPerHour}.</span>` : '';
  const btns = actions ? `<div class="row-actions">
      <button data-lane-toggle="${esc(p.id)}">${off ? 'Turn on' : 'Turn off'}</button>
      ${p.enabled && row?.total ? `<button data-lane-test="${esc(p.id)}">Test its models</button>` : ''}
      <button data-lane-key="${esc(p.id)}">${p.keys > p.discovered ? 'Add another key' : (p.lane?.keyless ? 'Add a token' : 'Add a key')}</button>
    </div>` : '';
  return `<div class="lane${off ? ' off' : ''}"><header><b>${esc(providerName(p.id))}</b>${badge}${off ? '<span class="tag">off</span>' : ''}</header>
    ${off ? '' : `<div>${laneSummary(row)}</div>`}
    <p class="muted" style="margin:0">${esc(p.lane?.note || '')}</p>${budget}${btns}</div>`;
}

function renderSnapshot(s) {
  lastSnapshot = s;
  if (typeof renderCompatFormState === 'function') renderCompatFormState(s.runtimePlatform === 'worker' && !s.compatCredentialsReady);
  renderOverview(s);
  if (typeof renderModels === 'function') renderModels(s);
  if (typeof renderProviders === 'function') renderProviders(s);
  if (typeof renderSecurity === 'function') renderSecurity(s);
  for (const hook of snapshotHooks) {
    try { hook(s); } catch { /* one page failing must not break the rest */ }
  }
}

async function load() {
  const [status, keys, compat] = await Promise.all([api('/api/status'), api('/api/client-keys'), api('/api/openai-compat/instances')]);
  renderSnapshot(status);
  if (typeof renderClientKeys === 'function') renderClientKeys(keys.keys);
  if (typeof renderCompatInstances === 'function') renderCompatInstances(compat.instances);
  if (activeTab === 'analytics' && typeof loadUsage === 'function') loadUsage();
}

function stream() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') renderSnapshot(msg.data);
      else if (msg.type === 'route' || msg.type === 'probe' || msg.type === 'compaction') {
        log(msg.type, msg.data);
        if (msg.type === 'route' && typeof usageRefreshSoon === 'function') usageRefreshSoon();
      }
    } catch { /* ignore malformed */ }
  };
  es.onerror = () => {
    $('dot').classList.remove('live');
    // A dead stream usually means the session ended; one status call tells us which.
    fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json()).then((b) => { if (!b.authenticated) showLogin('Your session ended. Sign in again.'); }).catch(() => {});
  };
}

// PUT /api/config answers with the stored config, not a status snapshot, so
// re-read the status after every settings write.
async function putConfig(patch) {
  await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
  renderSnapshot(await api('/api/status'));
}

function showLogin(message) {
  if (es) { es.close(); es = null; }
  $('login').classList.remove('hidden');
  $('loginErr').textContent = message || '';
  $('loginPassword').focus();
}

function unlock() {
  $('login').classList.add('hidden');
  $('loginErr').textContent = '';
  stream();
  load().catch(fail);
}

async function signOut() {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  showLogin('');
}

// ---------- wiring ----------
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginBtn').disabled = true;
  $('loginErr').textContent = '';
  try {
    const res = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('loginPassword').value }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const wait = res.headers.get('retry-after');
      throw new Error((body?.error?.message || 'Could not sign in') + (res.status === 429 && wait ? ` (try again in ${wait}s)` : ''));
    }
    $('loginPassword').value = '';
    unlock();
  } catch (err) {
    $('loginErr').textContent = err.message;
  } finally {
    $('loginBtn').disabled = false;
  }
});
$('logoutBtn').onclick = signOut;
$('refreshBtn').onclick = async () => {
  $('refreshBtn').classList.add('busy');
  try { renderSnapshot(await api('/api/catalog/refresh', { method: 'POST', body: '{}' })); toast('Catalog refreshed'); }
  catch (e) { fail(e); } finally { $('refreshBtn').classList.remove('busy'); }
};
$('strategy').onchange = async () => {
  try { await putConfig({ selection: { strategy: $('strategy').value } }); toast('Routing changed to ' + $('strategy').value); }
  catch (e) { fail(e); $('strategy').value = lastSnapshot?.strategy; }
};
document.addEventListener('click', (e) => {
  const tab = e.target.closest('#tabs button[data-tab]');
  if (tab) showTab(tab.dataset.tab);
  const goTab = e.target.closest('[data-go-tab]');
  if (goTab) go(goTab.dataset.goTab);
  const status = e.target.closest('[data-go-status]');
  if (status) go('models', { status: status.dataset.goStatus });
  const copy = e.target.closest('button[data-copy]');
  if (copy) copyText(copy.dataset.copy === 'openai' ? $('openaiEndpoint').textContent : $('anthropicEndpoint').textContent, copy);
});
window.addEventListener('hashchange', () => showTab(location.hash.slice(1), { keepHash: true }));

// Already signed in (valid cookie)? Skip the form.
(async () => {
  showTab(location.hash.slice(1) || 'overview', { keepHash: true });
  try { const res = await fetch('/api/session', { credentials: 'same-origin' }); if ((await res.json()).authenticated) unlock(); else $('loginPassword').focus(); }
  catch { $('loginErr').textContent = 'Cannot reach the router.'; }
})();
