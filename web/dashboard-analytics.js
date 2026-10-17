/* PURPOSE: Dashboard analytics page — usage ledger cards + zero-dep SVG charts (requests/success rate, latency, tokens), provider/model rollups + live activity feed + audit trail. Served at /dashboard-analytics.js */
/* OWNS: everything behind the analytics tab (usage cards/charts/tables, usageRefreshSoon live hook, live activity, audit trail) */
/* READ-WHEN: editing usage or log views; shared helpers ($/api/esc/log/fail/load) come from dashboard.js */
/* KEY-FILES: web/dashboard.html (DOM ids), web/dashboard.js (helpers/load), src/dashboard.mjs + src/usage.mjs (data) */
/* INVARIANTS: zero deps; esc() every interpolation; renders only sanitized ledger/audit fields */
/* GOTCHAS: dashboard.js is the loader — do not redeclare its globals; the #log feed keeps collecting while the tab is hidden */
/* UPDATED: 2026-10-14 */
'use strict';

// ---------- usage ----------
function usageWindowHours() { return Number($('usageWindow').value) || 24; }

function windowHourly(hourly) {
  const cutoff = Date.now() - usageWindowHours() * 3600_000;
  return (hourly || []).filter((b) => b.ts >= cutoff);
}

// Zero-dep SVG chart primitives — shapes only (no text nodes): the svg scales
// with preserveAspectRatio="none", so labels live in native <title> tooltips.
function chartSvg(inner) {
  return `<svg class="ch" viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true">${inner}</svg>`;
}
function chartEmpty(msg) { return `<div class="muted">${msg}</div>`; }

function renderUsageChart(hourly) {
  const bars = windowHourly(hourly);
  if (!bars.length) { $('usageChart').innerHTML = chartEmpty('no requests in this window yet'); return; }
  const max = Math.max(1, ...bars.map((b) => b.requests));
  const slot = 600 / bars.length;
  const bw = Math.max(1, slot - 2);
  let out = '<line class="gridline" x1="0" y1="139" x2="600" y2="139"/>';
  const pts = [];
  bars.forEach((b, i) => {
    const h = b.requests ? Math.max(2, Math.round((b.requests / max) * 126)) : 0;
    const t = new Date(b.ts).toTimeString().slice(0, 5);
    const tip = `${t} — ${b.requests} req, ${b.ok} ok, ${b.fail} fail, ${b.successRate != null ? Math.round(b.successRate * 100) : 0}% ok`;
    if (h) out += `<rect class="bar${b.fail > b.ok ? ' bad' : ''}" x="${(i * slot + 1).toFixed(1)}" y="${139 - h}" width="${bw.toFixed(1)}" height="${h}"><title>${esc(tip)}</title></rect>`;
    if (b.requests > 0) pts.push(`${(i * slot + slot / 2).toFixed(1)},${139 - Math.round((b.successRate ?? 0) * 126)}`);
  });
  if (pts.length > 1) out += `<polyline class="ln" points="${pts.join(' ')}"/>`;
  $('usageChart').innerHTML = chartSvg(out)
    + '<div class="chart-legend"><span><i></i>requests</span><span><i class="line"></i>success %</span>'
    + '<span><i class="bad"></i>fail-majority hour</span></div>';
}

function renderLatChart(hourly) {
  const hs = windowHourly(hourly).filter((b) => b.avgMs != null);
  if (!hs.length) { $('usageLatChart').innerHTML = chartEmpty('no successful requests yet'); return; }
  const max = Math.max(1, ...hs.map((b) => b.avgMs));
  const slot = 600 / hs.length;
  let out = '<line class="gridline" x1="0" y1="139" x2="600" y2="139"/>';
  const pts = hs.map((b, i) => {
    const t = new Date(b.ts).toTimeString().slice(0, 5);
    return { x: i * slot + slot / 2, y: 139 - Math.round((b.avgMs / max) * 126), slot, i, tip: `${t} — ${b.avgMs} ms avg, ${b.ok} ok` };
  });
  out += `<polyline class="ln" points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}"/>`;
  // Full-height hover gutters: the polyline carries no per-point tooltips.
  for (const p of pts) out += `<rect x="${(p.i * p.slot).toFixed(1)}" y="0" width="${p.slot.toFixed(1)}" height="140" fill="transparent"><title>${esc(p.tip)}</title></rect>`;
  $('usageLatChart').innerHTML = chartSvg(out)
    + `<div class="chart-legend"><span><i class="line"></i>avg ms (peak ${max})</span></div>`;
}

function renderTokChart(hourly) {
  const bars = windowHourly(hourly);
  if (!bars.some((b) => b.tokensOut > 0)) { $('usageTokChart').innerHTML = chartEmpty('no token traffic yet'); return; }
  const max = Math.max(1, ...bars.map((b) => b.tokensOut));
  const slot = 600 / bars.length;
  const bw = Math.max(1, slot - 2);
  let out = '<line class="gridline" x1="0" y1="139" x2="600" y2="139"/>';
  bars.forEach((b, i) => {
    const h = b.tokensOut ? Math.max(2, Math.round((b.tokensOut / max) * 126)) : 0;
    const t = new Date(b.ts).toTimeString().slice(0, 5);
    if (h) out += `<rect class="bar" x="${(i * slot + 1).toFixed(1)}" y="${139 - h}" width="${bw.toFixed(1)}" height="${h}"><title>${esc(`${t} — ${b.tokensOut} out / ${b.tokensIn} in tokens`)}</title></rect>`;
  });
  $('usageTokChart').innerHTML = chartSvg(out)
    + `<div class="chart-legend"><span><i></i>tokens out (peak ${max})</span></div>`;
}

function renderUsage(u) {
  const t = u.totals || {};
  $('usageCards').innerHTML = [
    ['requests', t.requests ?? 0],
    ['ok', t.ok ?? 0],
    ['failed', t.fail ?? 0],
    ['retries', t.failover ?? 0],
    ['success', t.successRate != null ? `${Math.round(t.successRate * 100)}%` : '-'],
    ['tokens in', t.tokensIn ?? 0],
    ['tokens out', t.tokensOut ?? 0],
    ['avg ms', t.avgMs ?? '-'],
  ].map(([label, v]) => `<div class="card"><b>${v}</b><span>${label}</span></div>`).join('');
  $('usagePersisted').textContent = `${Math.round((u.retainHours ?? 168) / 24)}-day ledger · ${u.persisted ? 'persisted' : 'pending flush'}`;
  renderUsageChart(u.hourly);
  renderLatChart(u.hourly);
  renderTokChart(u.hourly);
  $('usageProviders').innerHTML = (u.providers || []).map((p) => {
    const share = t.requests > 0 ? Math.round((p.requests / t.requests) * 100) : 0;
    return `<tr><td>${esc(p.provider)}</td><td>${p.requests}</td><td>${p.requests > 0 ? Math.round((p.ok / p.requests) * 100) : 0}%</td>`
      + `<td>${p.tokensIn}/${p.tokensOut}</td><td>${p.avgMs ?? '-'}</td>`
      + `<td><span class="share" title="${share}% of requests"><i style="width:${share}%"></i></span></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">no traffic yet</td></tr>';
  $('usageModels').innerHTML = (u.models || []).map((m, i) => {
    const pct = m.requests > 0 ? ` · ${Math.round((m.ok / m.requests) * 100)}%` : '';
    return `<tr><td class="muted">${i + 1}</td><td>${esc(m.id)}</td><td class="muted">${esc(m.provider ?? '-')}</td>`
      + `<td>${m.requests}</td><td>${m.ok}/${m.fail}${pct}</td><td>${m.tokensIn}/${m.tokensOut}</td><td>${m.avgMs ?? '-'}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">no model traffic yet</td></tr>';
  $('usageKeys').innerHTML = (u.keys || []).map((k) => {
    const last = k.lastAt ? new Date(k.lastAt).toLocaleString() : 'never';
    return `<tr><td>${esc(k.label)}</td><td>${k.requests}</td><td>${k.ok}/${k.fail}</td><td class="muted">${esc(last)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">no client-key traffic yet</td></tr>';
}

async function loadUsage() {
  try { renderUsage(await api('/api/usage')); } catch (err) { fail(err); }
}

// Route events on the SSE stream refresh the charts while this tab is visible
// (debounced so a failover burst is one redraw, not N).
let usageTimer = null;
function usageRefreshSoon() {
  if (activeTab !== 'analytics' || usageTimer) return;
  usageTimer = setTimeout(() => { usageTimer = null; loadUsage(); }, 1500);
}

$('usageWindow').addEventListener('change', loadUsage);
$('usageResetBtn').onclick = async () => {
  if (!confirm('Reset the usage ledger? All counters and history are wiped.')) return;
  try { renderUsage(await api('/api/usage/reset', { method: 'POST', body: '{}' })); }
  catch (err) { fail(err); }
};

// ---------- live activity + audit trail ----------
async function loadAudit() {
  try {
    const out = await api('/api/audit');
    $('audit').innerHTML = (out.entries || []).map((e2) => {
      const t = e2.at ? new Date(e2.at).toTimeString().slice(0, 8) : '--:--:--';
      const detail = Object.entries(e2).filter(([k]) => !['at', 'action'].includes(k)).map(([k, v]) => `${k}=${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(' ');
      return `<div><span class="t">${t}</span><b>${esc(e2.action ?? '')}</b> <span class="muted">${detail}</span></div>`;
    }).join('') || '<div class="muted">no audit entries yet</div>';
  } catch (err) { fail(err); }
}

$('auditRefreshBtn').onclick = loadAudit;
