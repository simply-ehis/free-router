/* PURPOSE: Dashboard core — auth, live stream, snapshot dispatch, overview page. Served at /dashboard.js */
/* OWNS: shared helpers ($, api, esc, log, toast, fail), tab shell, status/overview rendering, snapshot hooks */
/* READ-WHEN: editing dashboard behavior; page code lives in dashboard-{models,pages,analytics,settings}.js */
/* KEY-FILES: web/dashboard.html (DOM), web/dashboard.css (styles), src/dashboard.mjs (API) */
/* INVARIANTS: zero deps; every interpolation escaped with esc(); no secrets ever rendered */
/* GOTCHAS: SSE snapshots rebuild table bodies every 2s — filter inputs must live outside rebuilt nodes; later script files are referenced only through typeof guards or onSnapshot(fn) hooks */
/* UPDATED: 2026-10-14 */
'use strict';
const $ = (id) => document.getElementById(id);
let dashboardPassword = sessionStorage.getItem('fr_dashboard_password') || '';
let es = null;
let lastSnapshot = null;
let activeTab = 'overview';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + dashboardPassword, ...(opts.headers || {}) },
  });
  if (res.status === 401) { lock(); throw new Error('invalid dashboard password'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || ('HTTP ' + res.status));
  return body;
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function log(type, data) {
  const el = document.createElement('div');
  const t = new Date().toTimeString().slice(0, 8);
  if (type === 'route') {
    el.innerHTML = `<span class="t">${t}</span>route → <b>${esc(data.model)}</b> ${data.ok ? '<span class="badge ok">ok</span>' : '<span class="badge bad">fail</span>'} ${data.ms ?? ''}ms attempts=${data.attempts ?? 1}${data.stream ? ' stream' : ''}`;
  } else if (type === 'probe') {
    el.innerHTML = `<span class="t">${t}</span>probe <b>${esc(data.model)}</b> ${data.ok ? '<span class="badge ok">ok</span>' : `<span class="badge bad">${esc(data.kind || 'fail')}</span>`}`;
  } else if (type === 'compaction') {
    el.innerHTML = `<span class="t">${t}</span>compact <b>${esc(data.model)}</b> <span class="badge dim">${esc(data.mode)}</span> dropped=${data.dropped} est=${data.est} window=${data.window}`;
  } else {
    el.innerHTML = `<span class="t">${t}</span><span class="muted">${esc(type)}</span>`;
  }
  const box = $('log');
  box.prepend(el);
  while (box.children.length > 80) box.lastChild.remove();
}

// ---------- feedback ----------
let toastTimer = null;
function toast(msg, kind) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3500);
}

// Remote-action failures need a visible surface — the activity feed alone is easy to miss.
function fail(err) {
  const msg = err?.message || String(err);
  log('error: ' + msg);
  toast(msg, 'bad');
}

// ---------- tabs ----------
function showTab(name) {
  activeTab = name;
  for (const btn of document.querySelectorAll('nav#tabs button[data-tab]')) btn.classList.toggle('active', btn.dataset.tab === name);
  for (const page of document.querySelectorAll('section.page')) page.classList.toggle('active', page.dataset.page === name);
  if (name === 'analytics') {
    if (typeof loadUsage === 'function') loadUsage();
    if (typeof loadAudit === 'function') loadAudit();
  }
  if (name === 'settings' && typeof loadSettings === 'function') loadSettings();
}

// ---------- snapshot hooks (page files register extra render work) ----------
const snapshotHooks = [];
function onSnapshot(fn) { snapshotHooks.push(fn); }

// ---------- overview ----------
function renderOverview(s) {
  $('dot').classList.toggle('live', s.models.refreshOk);
  $('title').textContent = s.name || 'free-router';
  $('meta').textContent = `strategy ${s.strategy} · pool ${s.pool || 'all'} · decision ${s.decision} · up ${s.uptimeSec}s`;
  $('cards').innerHTML = [
    ['models', s.models.free],
    ['demoted', s.models.demoted],
    ['providers live', s.providers.filter((p) => p.enabled && p.keys > 0).length],
    ['requests', s.routes.requests],
    ['ok', s.routes.ok],
    ['unhealthy', s.routes.unhealthy],
  ].map(([label, v]) => `<div class="card"><b>${v}</b><span>${label}</span></div>`).join('');
  $('openaiEndpoint').textContent = location.origin + '/v1';
  $('anthropicEndpoint').textContent = location.origin + '/v1/messages';
  const sel = $('strategy');
  if (sel.dataset.init !== '1') {
    sel.innerHTML = ['sticky', 'fastest', 'roundrobin', 'smartest'].map((n) => `<option value="${n}">${n}</option>`).join('');
    sel.dataset.init = '1';
  }
  sel.value = s.strategy;
  const summary = (s.providers || []).map((p) => {
    const auto = p.discovered ? ` (${p.discovered} auto)` : '';
    return `<tr><td>${esc(p.id)}</td><td>${p.keys} <span class="muted">${p.enabled ? '' : '(disabled)'}${auto}</span></td><td></td></tr>`;
  }).join('');
  $('providersSummary').innerHTML = summary;
  const probe = s.probe || {};
  const probeRows = Object.entries(probe).slice(0, 6);
  $('probeCards').innerHTML = probeRows.length
    ? probeRows.map(([id, p]) => `<div class="card"><b class="small">${p.lastOk ? 'ok' : (p.lastErr ? esc(p.lastErr.kind || 'fail') : 'new')}</b><span>${esc(id)}</span></div>`).join('')
    : '<div class="muted">no probes yet — a cycle runs every probe interval</div>';
}

function renderSnapshot(s) {
  lastSnapshot = s;
  const cloudCompatUnavailable = s.runtimePlatform === 'worker' && !s.compatCredentialsReady;
  if (typeof renderCompatFormState === 'function') renderCompatFormState(cloudCompatUnavailable);
  renderOverview(s);
  if (typeof renderModels === 'function') renderModels(s);
  if (typeof renderProviders === 'function') renderProviders(s);
  if (typeof renderSecurity === 'function') renderSecurity(s);
  for (const hook of snapshotHooks) {
    try { hook(s); } catch { /* one page failing must not break the rest */ }
  }
}

// ---------- actions ----------
async function act(action, modelId) {
  try {
    if (action === 'try') {
      $('tryResult').textContent = 'Testing ' + modelId + '…';
      const out = await api('/api/models/try', { method: 'POST', body: JSON.stringify({ modelId }) });
      $('tryResult').textContent = out.ok
        ? `OK → ${out.actualModel} → ${out.ms} ms → ${out.preview}`
        : `Failed → ${out.error} → ${out.ms} ms`;
      await load();
      return;
    }
    const path = action === 'blacklist' ? '/api/routes/blacklist'
      : action === 'unblacklist' ? '/api/routes/unblacklist' : '/api/routes/' + action;
    renderSnapshot(await api(path, { method: 'POST', body: JSON.stringify({ modelId }) }));
  } catch (e) { $('tryResult').textContent = 'Error → ' + e.message; }
}

async function dropKey(provider) {
  if (lastSnapshot === null) return;
  const p = (lastSnapshot.providers || []).find((x) => x.id === provider);
  if (!p) return;
  const label = provider + '-' + (p.configured ?? p.keys);
  try {
    await api('/api/keys', { method: 'DELETE', body: JSON.stringify({ provider, label }) });
    await load();
  } catch (e) { fail(e); }
}

async function load() {
  const [status, keys, compat, usage] = await Promise.all([
    api('/api/status'), api('/api/client-keys'), api('/api/openai-compat/instances'), api('/api/usage').catch(() => null),
  ]);
  renderSnapshot(status);
  if (typeof renderClientKeys === 'function') renderClientKeys(keys.keys);
  if (typeof renderCompatInstances === 'function') renderCompatInstances(compat.instances);
  if (usage && typeof renderUsage === 'function') renderUsage(usage);
}

function stream() {
  if (es) es.close();
  es = new EventSource('/api/events?key=' + encodeURIComponent(dashboardPassword));
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') renderSnapshot(msg.data);
      else if (msg.type === 'route' || msg.type === 'probe' || msg.type === 'compaction') {
        log(msg.type, msg.data);
        if (msg.type === 'probe') load();
        if (msg.type === 'route' && typeof usageRefreshSoon === 'function') usageRefreshSoon();
      }
    } catch { /* ignore malformed */ }
  };
  es.onerror = () => { $('dot').classList.remove('live'); };
}

function unlock() { $('login').classList.add('hidden'); stream(); load().catch(fail); }
function lock() { dashboardPassword = ''; sessionStorage.removeItem('fr_dashboard_password'); if (es) { es.close(); es = null; } $('login').classList.remove('hidden'); }

// ---------- wiring ----------
$('loginBtn').onclick = async () => {
  dashboardPassword = $('loginPassword').value.trim();
  $('loginErr').textContent = '';
  try { await api('/api/status'); sessionStorage.setItem('fr_dashboard_password', dashboardPassword); unlock(); }
  catch (e) { $('loginErr').textContent = e.message; }
};
$('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });
$('logoutBtn').onclick = lock;
$('refreshBtn').onclick = async () => { try { renderSnapshot(await api('/api/catalog/refresh', { method: 'POST', body: '{}' })); } catch (e) { fail(e); } };
$('strategy').onchange = async () => {
  try { renderSnapshot(await api('/api/config', { method: 'PUT', body: JSON.stringify({ selection: { strategy: $('strategy').value } }) })); }
  catch (e) { fail(e); $('strategy').value = lastSnapshot?.strategy; }
};
document.addEventListener('click', (e) => {
  const tab = e.target.closest('nav#tabs button[data-tab]');
  if (tab) showTab(tab.dataset.tab);
  const action = e.target.closest('button[data-action]');
  if (action) act(action.dataset.action, action.dataset.model);
  const copy = e.target.closest('button[data-copy]');
  if (copy) {
    const value = copy.dataset.copy === 'openai' ? $('openaiEndpoint').textContent : $('anthropicEndpoint').textContent;
    navigator.clipboard?.writeText(value).then(() => { copy.textContent = 'copied'; setTimeout(() => { copy.textContent = 'copy'; }, 1200); });
  }
});
if (dashboardPassword) unlock();
