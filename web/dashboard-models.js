/* PURPOSE: Dashboard models page — sortable/filterable model viewer with priority pins, try/demote/blacklist actions. Served at /dashboard-models.js */
/* OWNS: everything behind the models tab (table render, filters, sorting, priority selects, action wiring) */
/* READ-WHEN: editing the model viewer; shared helpers (api/esc/log/act/fail) come from dashboard.js */
/* KEY-FILES: web/dashboard.html (DOM ids), web/dashboard.js (renderSnapshot dispatch), src/dashboard.mjs (API) */
/* INVARIANTS: zero deps; esc() every interpolation; renders only sanitized snapshot fields */
/* GOTCHAS: SSE snapshots rebuild the table body every 2s — filter/sort inputs live outside #routes and must not be re-rendered */
/* UPDATED: 2026-10-14 */
'use strict';

const modelSort = { key: 'score', dir: -1 };
const expandedModels = new Set(); // "why" breakdown rows open across snapshot rebuilds
const modelPrefs = {
  freeOnly: localStorage.getItem('fr_free_only') === '1',
  provider: localStorage.getItem('fr_provider_filter') || 'all',
};

function sortValue(m, key) {
  switch (key) {
    case 'model': return m.id.toLowerCase();
    case 'provider': return m.provider.toLowerCase();
    case 'traffic': return (m.ok ?? 0) + (m.fail ?? 0);
    case 'ms': return m.latencyMs ?? Number.MAX_SAFE_INTEGER;
    case 'score': default: return m.score ?? -1;
  }
}

function compareModels(a, b) {
  const va = sortValue(a, modelSort.key);
  const vb = sortValue(b, modelSort.key);
  const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
  return cmp * modelSort.dir || a.id.localeCompare(b.id);
}

function prioritySelect(m, s) {
  return `<select data-priority-model="${esc(m.id)}" title="model priority">`
    + [0, 0.25, 0.5, 0.75, 1].map((v) => `<option value="${v}" ${((s.selectionPriorities?.[m.id] ?? 0.5) === v ? 'selected' : '')}>P${v}</option>`).join('')
    + '</select>';
}

function breakdownRow(m) {
  const parts = Object.entries(m.components ?? {}).map(([k, v]) => {
    const w = m.weights?.[k] ?? 0;
    return `<span class="badge dim" title="${esc(k)}: ${v.toFixed(2)} × weight ${w.toFixed(2)}">${esc(k)} ${v.toFixed(2)}×${w.toFixed(2)}</span>`;
  }).join(' ');
  return `<tr class="detail"><td colspan="7"><div class="breakdown">${parts} <span class="badge score">total ${m.score}</span>`
    + ` <span class="muted">component value × your weight — weights renormalize over active components</span></div></td></tr>`;
}

function renderModels(s) {
  const models = [...(s.modelsDetail || [])].sort(compareModels);
  const activeRows = models.flatMap((m) => {
    const dead = m.unhealthyUntil > Date.now();
    const freeTag = (m.sources && m.sources.length)
      ? `<span class="badge ok" title="${esc(m.sources.join(', '))}">free</span>`
      : '<span class="badge dim" title="no free-tier evidence — runtime billing demotion is the cost guard">unverified</span>';
    const state = dead ? '<span class="badge bad">cooldown</span>' : '<span class="badge ok">ready</span>';
    const priority = s.selectionPriorities?.[m.id] != null ? ` <span class="badge warn" title="non-default priority">pinned</span>` : '';
    const row = `<tr data-search="${esc((m.id + ' ' + m.provider).toLowerCase())}" data-free="${(m.sources && m.sources.length) ? 1 : 0}" data-provider="${esc(m.provider)}">`
      + `<td>${esc(m.id)} ${freeTag}${priority}</td><td class="muted">${esc(m.provider)}</td>`
      + `<td><span class="badge score">${m.score ?? '-'}</span></td><td>${state}</td>`
      + `<td>${m.ok ?? 0}/${m.fail ?? 0}</td><td>${m.latencyMs ?? '-'}</td>`
      + `<td class="actions">${prioritySelect(m, s)} <button data-why="${esc(m.id)}" title="component breakdown">${expandedModels.has(m.id) ? 'hide' : 'why'}</button> <button data-action="try" data-model="${esc(m.id)}">try</button> <button data-action="demote" data-model="${esc(m.id)}">disable</button> <button class="danger" data-action="blacklist" data-model="${esc(m.id)}">blacklist</button></td></tr>`;
    return expandedModels.has(m.id) ? [row, breakdownRow(m)] : [row];
  });
  const excludedEntries = Object.entries(s.demoted || {});
  for (const id of s.blacklist || []) if (!s.demoted?.[id]) excludedEntries.push([id, { reason: 'blacklisted' }]);
  const excludedRows = excludedEntries.map(([id, detail]) => {
    const blacklisted = (s.blacklist || []).includes(id) || detail?.reason === 'blacklisted';
    const action = blacklisted ? 'unblacklist' : 'reinstate';
    const state = blacklisted ? 'blacklisted' : 'demoted';
    return `<tr data-search="${esc((id + ' ' + state).toLowerCase())}" data-free="0" data-provider="">`
      + `<td>${esc(id)}</td><td class="muted">-</td><td>-</td>`
      + `<td><span class="badge bad">${state}</span></td><td>-</td><td>-</td>`
      + `<td class="actions"><button data-action="${action}" data-model="${esc(id)}">${action}</button></td></tr>`;
  });
  $('routes').innerHTML = [...activeRows, ...excludedRows].join('') || '<tr><td colspan="7" class="muted">no models - add an endpoint or provider key</td></tr>';

  const providerSel = $('providerFilter');
  const providers = [...new Set(models.map((m) => m.provider))].sort();
  if (providerSel.dataset.init !== '1' || providerSel.dataset.sig !== providers.join(',')) {
    providerSel.innerHTML = '<option value="all">all providers</option>' + providers.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    providerSel.dataset.init = '1';
    providerSel.dataset.sig = providers.join(',');
    if (!providers.includes(modelPrefs.provider)) modelPrefs.provider = 'all';
  }
  providerSel.value = modelPrefs.provider;
  $('freeOnly').checked = modelPrefs.freeOnly;
  $('sortModels').value = modelSort.key;
  $('modelCount').textContent = `${(s.modelsDetail || []).length} active / ${excludedRows.length} excluded`;
  for (const th of document.querySelectorAll('th[data-sort]')) th.classList.toggle('sorted', th.dataset.sort === modelSort.key);
  filterModels();
}

function filterModels() {
  const q = $('modelFilter').value.trim().toLowerCase();
  let visible = 0;
  for (const row of $('routes').querySelectorAll('tr[data-search]')) {
    const ok = row.dataset.search.includes(q)
      && (modelPrefs.provider === 'all' || row.dataset.provider === modelPrefs.provider)
      && (!modelPrefs.freeOnly || row.dataset.free === '1');
    row.hidden = !ok;
    if (ok) visible += 1;
  }
  const total = $('routes').querySelectorAll('tr[data-search]').length;
  if (total > 0) $('modelCount').textContent = `${visible} shown / ${total} listed`;
}

// ---------- wiring ----------
$('modelFilter').addEventListener('input', filterModels);
$('freeOnly').addEventListener('change', () => {
  modelPrefs.freeOnly = $('freeOnly').checked;
  localStorage.setItem('fr_free_only', modelPrefs.freeOnly ? '1' : '0');
  filterModels();
});
$('providerFilter').addEventListener('change', () => {
  modelPrefs.provider = $('providerFilter').value;
  localStorage.setItem('fr_provider_filter', modelPrefs.provider);
  filterModels();
});
$('sortModels').addEventListener('change', () => { modelSort.key = $('sortModels').value; if (lastSnapshot) renderModels(lastSnapshot); });
$('routes').addEventListener('change', async (e) => {
  const field = e.target.closest('select[data-priority-model]');
  if (!field) return;
  try { renderSnapshot(await api('/api/models/priority', { method: 'POST', body: JSON.stringify({ modelId: field.dataset.priorityModel, priority: Number(field.value) }) })); }
  catch (err) { fail(err); }
});
document.addEventListener('click', (e) => {
  const why = e.target.closest('button[data-why]');
  if (why) {
    const id = why.dataset.why;
    if (expandedModels.has(id)) expandedModels.delete(id); else expandedModels.add(id);
    if (lastSnapshot) renderModels(lastSnapshot);
    return;
  }
  const sorter = e.target.closest('th[data-sort]');
  if (!sorter) return;
  const key = sorter.dataset.sort;
  modelSort.dir = modelSort.key === key ? -modelSort.dir : (key === 'model' || key === 'provider' ? 1 : -1);
  modelSort.key = key;
  if (lastSnapshot) renderModels(lastSnapshot);
});
