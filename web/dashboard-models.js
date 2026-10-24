/* PURPOSE: Dashboard models page — filter by status/provider/free, sort, test models, see why a model was filtered out, allow it back. Served at /dashboard-models.js */
/* OWNS: everything behind the Models tab (list render, chips, filters, sorting, test/verify batches, filtered-out + disabled lists) */
/* READ-WHEN: editing the models page; the data comes from statusSnapshot() in src/dashboardStatus.mjs (health, kind, recent, filteredModels) */
/* INVARIANTS: filters live outside the re-rendered list; rows render through setHtml() so a snapshot with no visible change touches nothing; "failing" filter includes cooling-down models */
/* GOTCHAS: Test sends real (tiny) requests — free tiers cap them, so large batches ask first and the server caps each call at 12 */
/* UPDATED: 2026-10-22 */
'use strict';
const modelPrefs = { status: 'all', provider: 'all', q: '', sort: 'status' };
try { modelPrefs.freeOnly = localStorage.getItem('fr_free_only') === '1'; } catch { modelPrefs.freeOnly = false; }
const expandedModels = new Set();
const testingModels = new Set();
let verifyCancel = false;
let verifyRunning = false;

const STATUS_RANK = { working: 0, limited: 1, untested: 2, cooldown: 3, failing: 4 };
const CHIPS = [['all', 'All'], ['working', 'Working'], ['limited', 'Rate limited'], ['failing', 'Failing'], ['untested', 'Not tested']];
const KIND_LABEL = { image: 'image', video: 'video', audio: 'audio / speech', embedding: 'embedding', rerank: 'reranker', moderation: 'safety classifier', ocr: 'OCR', other: 'other' };

function setModelFilter({ status, provider } = {}) {
  if (status) modelPrefs.status = status;
  if (provider) modelPrefs.provider = provider;
  if (lastSnapshot) renderModels(lastSnapshot);
}

function matchesStatus(m) {
  if (modelPrefs.status === 'all') return true;
  if (modelPrefs.status === 'failing') return m.health === 'failing' || m.health === 'cooldown';
  return m.health === modelPrefs.status;
}

function baseFiltered(s) {
  const q = modelPrefs.q.trim().toLowerCase();
  return (s.modelsDetail || []).filter((m) => (modelPrefs.provider === 'all' || m.provider === modelPrefs.provider)
    && (!modelPrefs.freeOnly || (m.sources?.length ?? 0) > 0)
    && (!q || m.id.toLowerCase().includes(q) || providerName(m.provider).toLowerCase().includes(q)));
}

function sortModels(list) {
  const by = {
    status: (a, b) => (STATUS_RANK[a.health] - STATUS_RANK[b.health]) || (b.score - a.score),
    score: (a, b) => b.score - a.score,
    ms: (a, b) => (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9),
    traffic: (a, b) => ((b.ok ?? 0) + (b.fail ?? 0)) - ((a.ok ?? 0) + (a.fail ?? 0)),
    model: (a, b) => a.id.localeCompare(b.id),
    provider: (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  }[modelPrefs.sort] || (() => 0);
  return [...list].sort((a, b) => by(a, b) || a.id.localeCompare(b.id));
}

function healthNote(m) {
  if (m.health === 'working') return `Last success ${ago(m.lastOkAt)}`;
  if (m.health === 'limited') return 'The free tier asked us to slow down. This is normal and not a failure.';
  if (m.health === 'cooldown') return `Benched briefly after repeated failures${m.unhealthyUntil ? ` until ${new Date(m.unhealthyUntil).toLocaleTimeString()}` : ''}.`;
  if (m.health === 'failing') return m.lastError ? `Last problem: ${m.lastError.kind || 'error'}${m.lastError.status ? ` (HTTP ${m.lastError.status})` : ''}, ${ago(m.lastError.at)}` : 'Recent requests failed.';
  return 'Never tested. Press Test to check it.';
}

function priorityMenu(m, s) {
  return `<select data-priority-model="${esc(m.id)}" aria-label="Priority">${[0, 0.25, 0.5, 0.75, 1].map((v) => `<option value="${v}" ${((s.selectionPriorities?.[m.id] ?? 0.5) === v ? 'selected' : '')}>Priority ${v}</option>`).join('')}</select>`;
}

function detailRow(m, s) {
  const parts = Object.entries(m.components ?? {}).map(([k, v]) => `<span class="badge" title="${esc(k)} ${v.toFixed(2)} times weight ${(m.weights?.[k] ?? 0).toFixed(2)}">${esc(k)} ${v.toFixed(2)}</span>`).join('');
  return `<li class="mdetail"><p style="margin:0 0 8px">${esc(healthNote(m))}</p>
    <div class="breakdown"><span class="badge score">score ${m.score}</span>${parts}<span class="muted">${m.ok ?? 0} ok and ${m.fail ?? 0} failed so far${m.latencyMs ? `, ${Math.round(m.latencyMs)} ms typical` : ''}</span></div>
    <div class="detail-actions">${priorityMenu(m, s)}<button data-act="demote" data-model="${esc(m.id)}" title="Take it out of the pool until you turn it back on">Disable</button><button class="danger" data-act="blacklist" data-model="${esc(m.id)}" title="Block it permanently">Block</button></div></li>`;
}

function modelRow(m, s) {
  const lane = (s.providers || []).find((p) => p.id === m.provider)?.lane;
  const free = (m.sources?.length ?? 0) > 0
    ? `<span class="tag ok" title="Evidence: ${esc(m.sources.join(', '))}">${lane?.keyless ? 'free, no key' : 'free tier'}</span>`
    : '<span class="tag" title="Nothing confirms this model is free">not confirmed free</span>';
  const pinned = s.selectionPriorities?.[m.id] != null ? '<span class="tag warn">pinned</span>' : '';
  const open = expandedModels.has(m.id);
  const testing = testingModels.has(m.id);
  const ms = m.checkMs ?? m.latencyMs;
  return `<li class="mrow" data-id="${esc(m.id)}"><span class="state ${m.health}" title="${STATUS_LABEL[m.health]}"></span>
    <div class="mname"><code>${esc(m.id)}</code><span class="muted">${esc(providerName(m.provider))}</span>${free}${pinned}</div>
    <div class="mstat"><span class="stlabel ${m.health}">${STATUS_LABEL[m.health]}</span>${strip(m.recent)}</div>
    <div class="mms" title="Response time">${ms ? Math.round(ms) + ' ms' : ''}</div><div class="mscore" title="Score">${m.score}</div>
    <div class="mact"><button data-act="test" data-model="${esc(m.id)}" ${testing ? 'disabled' : ''}>${testing ? 'Testing' : 'Test'}</button><button class="ghost" data-act="why" data-model="${esc(m.id)}" aria-expanded="${open}">${open ? 'Hide' : 'Details'}</button></div></li>${open ? detailRow(m, s) : ''}`;
}

function renderChips(s, base) {
  const counts = { all: base.length, working: 0, limited: 0, failing: 0, untested: 0 };
  for (const m of base) counts[m.health === 'cooldown' ? 'failing' : m.health] += 1;
  setHtml($('statusChips'), CHIPS.map(([k, label]) => `<button data-chip="${k}" aria-pressed="${modelPrefs.status === k}">${label}<span class="n">${counts[k]}</span></button>`).join(''));
}

function renderProviderFilter(s) {
  const sel = $('providerFilter');
  const ids = [...new Set((s.modelsDetail || []).map((m) => m.provider))].sort();
  const sig = ids.join(',');
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = '<option value="all">All providers</option>' + ids.map((id) => `<option value="${esc(id)}">${esc(providerName(id))}</option>`).join('');
    sel.dataset.sig = sig;
  }
  if (modelPrefs.provider !== 'all' && !ids.includes(modelPrefs.provider)) modelPrefs.provider = 'all';
  sel.value = modelPrefs.provider;
}

function renderFiltered(s) {
  const list = s.filteredModels || [];
  const counts = {};
  for (const f of list) counts[f.kind] = (counts[f.kind] || 0) + 1;
  const breakdown = Object.entries(counts).map(([k, n]) => `${n} ${KIND_LABEL[k] || k}`).join(', ');
  $('filteredTitle').textContent = list.length ? `Filtered out: ${list.length} models that are not chat models (${breakdown})` : 'Filtered out: nothing right now';
  const kindSel = $('filteredKind');
  const kinds = Object.keys(counts).sort();
  if (kindSel.dataset.sig !== kinds.join(',')) {
    kindSel.innerHTML = '<option value="all">All kinds</option>' + kinds.map((k) => `<option value="${k}">${esc(KIND_LABEL[k] || k)}</option>`).join('');
    kindSel.dataset.sig = kinds.join(',');
  }
  const kind = kindSel.value || 'all';
  const rows = list.filter((f) => kind === 'all' || f.kind === kind).slice(0, 200);
  setHtml($('filteredRows'), rows.length ? rows.map((f) => `<li class="mrow"><div class="mname"><code>${esc(f.id)}</code><span class="muted">${esc(providerName(f.provider))}</span><span class="tag">${esc(KIND_LABEL[f.kind] || f.kind)}</span></div>
      <button data-act="allow" data-model="${esc(f.id)}" title="Add it to the pool anyway">Allow as chat</button><span class="why">${esc(f.reason)}</span></li>`).join('')
    : '<li class="empty-note">Nothing was filtered out.</li>');
}

function renderOff(s) {
  const rows = [];
  for (const [id, d] of Object.entries(s.demoted || {})) {
    const until = d.until ? `back ${new Date(d.until).toLocaleTimeString()}` : 'stays out until you bring it back';
    rows.push(`<li class="mrow"><div class="mname"><code>${esc(id)}</code><span class="tag warn">${esc(String(d.reason || 'disabled').replace(/-/g, ' '))}</span></div><button data-act="reinstate" data-model="${esc(id)}">Bring back</button><span class="why">${esc(until)}</span></li>`);
  }
  for (const id of s.blacklist || []) {
    if (s.demoted?.[id]) continue;
    rows.push(`<li class="mrow"><div class="mname"><code>${esc(id)}</code><span class="tag bad">blocked</span></div><button data-act="unblacklist" data-model="${esc(id)}">Unblock</button></li>`);
  }
  for (const id of s.forceChat || []) {
    rows.push(`<li class="mrow"><div class="mname"><code>${esc(id)}</code><span class="tag acc">allowed as chat</span></div><button data-act="unallow" data-model="${esc(id)}">Stop allowing</button></li>`);
  }
  $('offTitle').textContent = `Disabled, blocked and allowed by you: ${rows.length}`;
  setHtml($('offRows'), rows.join('') || '<li class="empty-note">Nothing here.</li>');
}

function renderModels(s) {
  renderProviderFilter(s);
  const base = baseFiltered(s);
  renderChips(s, base);
  const shown = sortModels(base.filter(matchesStatus));
  $('modelCount').textContent = shown.length === (s.modelsDetail || []).length ? `${shown.length} models` : `Showing ${shown.length} of ${(s.modelsDetail || []).length} models`;
  $('verifyShownBtn').disabled = verifyRunning || shown.length === 0;
  const head = '<li class="mhead" aria-hidden="true"><span></span><span>Model</span><span>Status</span><span>Speed</span><span>Score</span><span></span></li>';
  setHtml($('routes'), shown.length ? head + shown.map((m) => modelRow(m, s)).join('')
    : `<li class="empty-note">${(s.modelsDetail || []).length ? 'No models match these filters.' : 'No models yet. Add a key under Providers, or turn on a free provider, then refresh the catalog.'}</li>`);
  renderFiltered(s);
  renderOff(s);
  const dl = $('modelIds');
  if (dl) setHtml(dl, (s.modelsDetail || []).map((m) => `<option value="${esc(m.id)}"></option>`).join(''));
}

// ---------- testing ----------
function summarize(results) {
  const ok = results.filter((r) => r.ok).length;
  const limited = results.filter((r) => r.limited).length;
  const bad = results.length - ok - limited;
  return `${results.length} tested: ${ok} working${limited ? `, ${limited} rate limited` : ''}${bad ? `, ${bad} failed` : ''}`;
}

async function testModels(ids, { quiet = false } = {}) {
  if (verifyRunning || ids.length === 0) return [];
  if (ids.length > 30 && !confirm(`Send one small request to each of ${ids.length} models? Free tiers have request limits, so this can take a while and some models may report rate limited.`)) return [];
  verifyRunning = true;
  verifyCancel = false;
  $('verifyStopBtn').classList.toggle('hidden', ids.length <= 12);
  ids.forEach((id) => testingModels.add(id));
  const all = [];
  try {
    for (let i = 0; i < ids.length && !verifyCancel; i += 12) {
      const batch = ids.slice(i, i + 12);
      $('verifyProgress').textContent = ids.length > 12 ? `Testing ${Math.min(i + 12, ids.length)} of ${ids.length}` : `Testing ${batch.length}`;
      const out = await api('/api/models/verify', { method: 'POST', body: JSON.stringify({ ids: batch }) });
      all.push(...out.results);
      batch.forEach((id) => testingModels.delete(id));
      renderSnapshot(await api('/api/status'));
    }
    if (!quiet) toast(summarize(all));
    $('verifyProgress').textContent = all.length ? summarize(all) : '';
  } catch (e) { fail(e); }
  finally {
    verifyRunning = false;
    testingModels.clear();
    $('verifyStopBtn').classList.add('hidden');
    if (lastSnapshot) renderModels(lastSnapshot);
  }
  return all;
}

async function testProvider(providerId) {
  if (!lastSnapshot) return;
  const ids = (lastSnapshot.modelsDetail || []).filter((m) => m.provider === providerId).sort((a, b) => (a.lastOkAt || 0) - (b.lastOkAt || 0)).map((m) => m.id);
  if (ids.length === 0) { toast('No models from this provider yet', 'bad'); return; }
  const first = ids.slice(0, 12);
  const out = await testModels(first, { quiet: true });
  if (out.length) toast(`${providerName(providerId)}: ${summarize(out)}${ids.length > 12 ? `. ${ids.length - 12} more can be tested from Models.` : ''}`);
}

// ---------- actions ----------
const ACTION_PATHS = { demote: '/api/routes/demote', reinstate: '/api/routes/reinstate', blacklist: '/api/routes/blacklist', unblacklist: '/api/routes/unblacklist', allow: '/api/models/allow', unallow: '/api/models/unallow' };

async function modelAction(action, modelId) {
  if (action === 'why') {
    if (expandedModels.has(modelId)) expandedModels.delete(modelId); else expandedModels.add(modelId);
    if (lastSnapshot) renderModels(lastSnapshot);
    return;
  }
  if (action === 'test') { await testModels([modelId]); return; }
  if (action === 'blacklist' && !confirm(`Block ${modelId}? It stays out of the pool until you unblock it.`)) return;
  try {
    renderSnapshot(await api(ACTION_PATHS[action], { method: 'POST', body: JSON.stringify({ modelId }) }));
    toast({ allow: 'Added to the pool', unallow: 'No longer forced into the pool', demote: 'Disabled', reinstate: 'Back in the pool', blacklist: 'Blocked', unblacklist: 'Unblocked' }[action]);
  } catch (e) { fail(e); }
}

// ---------- wiring ----------
$('modelFilter').addEventListener('input', (e) => { modelPrefs.q = e.target.value; if (lastSnapshot) renderModels(lastSnapshot); });
$('providerFilter').addEventListener('change', (e) => { modelPrefs.provider = e.target.value; if (lastSnapshot) renderModels(lastSnapshot); });
$('sortModels').addEventListener('change', (e) => { modelPrefs.sort = e.target.value; if (lastSnapshot) renderModels(lastSnapshot); });
$('freeOnly').checked = modelPrefs.freeOnly;
$('freeOnly').addEventListener('change', (e) => {
  modelPrefs.freeOnly = e.target.checked;
  try { localStorage.setItem('fr_free_only', e.target.checked ? '1' : '0'); } catch { /* not persisted */ }
  if (lastSnapshot) renderModels(lastSnapshot);
});
$('filteredKind').addEventListener('change', () => { if (lastSnapshot) renderFiltered(lastSnapshot); });
$('verifyStopBtn').onclick = () => { verifyCancel = true; $('verifyProgress').textContent = 'Stopping after this batch'; };
$('verifyShownBtn').onclick = () => {
  if (!lastSnapshot) return;
  const ids = sortModels(baseFiltered(lastSnapshot).filter(matchesStatus)).map((m) => m.id);
  testModels(ids);
};
$('statusChips').addEventListener('click', (e) => {
  const chip = e.target.closest('button[data-chip]');
  if (chip) setModelFilter({ status: chip.dataset.chip });
});
document.querySelector('[data-page="models"]').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) modelAction(btn.dataset.act, btn.dataset.model);
});
document.querySelector('[data-page="models"]').addEventListener('change', async (e) => {
  const field = e.target.closest('select[data-priority-model]');
  if (!field) return;
  try { renderSnapshot(await api('/api/models/priority', { method: 'POST', body: JSON.stringify({ modelId: field.dataset.priorityModel, priority: Number(field.value) }) })); toast('Priority saved'); }
  catch (err) { fail(err); }
});
