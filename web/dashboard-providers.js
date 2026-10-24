/* PURPOSE: Dashboard providers page — free lanes, per-key management (list/on-off/remove/test), add keys, custom OpenAI-compatible endpoints. Served at /dashboard-providers.js */
/* OWNS: everything behind the Providers tab */
/* READ-WHEN: editing key handling or provider controls; endpoints live in src/dashboard.mjs, key storage in src/providerKeys.mjs */
/* KEY-FILES: web/dashboard.html (DOM ids), web/dashboard.js (api/esc/laneCard/healthByProvider helpers, renderSnapshot), src/dashboardStatus.mjs (keyList + lane info) */
/* INVARIANTS: esc() every interpolation; keys are write-only (only masked values are ever rendered); a key is removed/toggled by its label, never by position in a list the user cannot see */
/* GOTCHAS: dashboard.js is the loader — $/api/esc/log/fail/toast/lastSnapshot come from there; this file must not redeclare them. Provider tiles rebuild every snapshot, so no form inputs live inside them */
/* UPDATED: 2026-10-22 */
'use strict';

// Last key-test result per provider; survives the 2s snapshot rebuilds.
const providerTests = new Map();
let storageUnavailable = false;

function testBadge(provider) {
  const t = providerTests.get(provider);
  if (!t) return '';
  if (t.ok) return `<span class="tag ok" title="Checked with ${esc(t.model)} and key ${esc(t.keyMasked ?? '?')}">Key works, ${t.ms} ms</span>`;
  return `<span class="tag bad" title="${esc(t.error ?? 'failed')}${t.model ? ` (tested model: ${esc(t.model)})` : ''}">Key problem: ${esc(t.errorKind || 'failed')}</span>`;
}

function renderCompatFormState(unavailable) {
  storageUnavailable = !!unavailable;
  for (const id of ['compatName', 'compatBaseUrl', 'compatApiKey', 'compatProbeBtn', 'keyProvider', 'keyValue', 'keyTestBtn']) {
    const el = $(id);
    if (el) el.disabled = storageUnavailable;
  }
  for (const btn of document.querySelectorAll('#keyForm button[type=submit], #compatForm button[type=submit]')) btn.disabled = storageUnavailable;
  $('storageBanner').hidden = !storageUnavailable;
}

function keyRows(p) {
  const own = (p.keyList || []).map((k) => `<div class="keyrow"><code>${esc(k.masked)}</code>
      <span class="tag ${k.enabled ? 'ok' : ''}">${k.enabled ? 'in use' : 'turned off'}</span>
      <button data-key-toggle="${esc(p.id)}" data-label="${esc(k.label)}" data-enabled="${k.enabled ? '0' : '1'}">${k.enabled ? 'Turn off' : 'Turn on'}</button>
      <button class="danger" data-key-remove="${esc(p.id)}" data-label="${esc(k.label)}">Remove</button></div>`);
  const auto = (p.autoLanes || []).filter((l) => l.source !== 'anonymous').map((l) => `<div class="keyrow"><code>${esc(l.label)}</code><span class="tag">${esc(l.source)}</span><span class="muted">found automatically, not stored here</span></div>`);
  return own.concat(auto).join('');
}

function providerBlock(p, row) {
  return `<div class="prov"><header><b>${esc(providerName(p.id))}</b>
      <span class="tag ${p.enabled ? 'ok' : ''}">${p.enabled ? 'on' : 'off'}</span>${testBadge(p.id)}
      <span class="spacer"></span>
      <button data-lane-test="${esc(p.id)}" ${row?.total ? '' : 'disabled'} title="Send tiny requests to up to 12 of its models">Test models</button>
      <button data-test-provider="${esc(p.id)}" title="One minimal request with your newest key">Test key</button>
      <button data-lane-toggle="${esc(p.id)}">${p.enabled ? 'Turn off' : 'Turn on'}</button></header>
    <div class="muted" style="margin-top:6px">${laneSummary(row)}</div>
    ${keyRows(p) || '<p class="muted" style="margin:8px 0 0">No key yet. Add one below.</p>'}</div>`;
}

function renderProviders(s) {
  const byProv = healthByProvider(s);
  const providers = (s.providers || []).filter((p) => p.id !== 'openai-compat');
  const lanes = providers.filter((p) => p.lane?.keyless);
  setHtml($('freeLanes2'), lanes.map((p) => {
    const keys = keyRows(p);
    return laneCard(p, byProv[p.id], { actions: true }).replace(/<\/div>$/, `${keys}</div>`);
  }).join(''));
  const keyed = providers.filter((p) => !p.lane?.keyless);
  const active = keyed.filter((p) => p.enabled || p.keys > 0);
  const idle = keyed.filter((p) => !p.enabled && p.keys === 0);
  setHtml($('providerList'), active.map((p) => providerBlock(p, byProv[p.id])).join('')
    + (idle.length ? `<div class="notset"><span class="muted">Not set up yet. Pick one to add a key:</span>${idle.map((p) => `<button data-lane-key="${esc(p.id)}">${esc(providerName(p.id))}</button>`).join('')}</div>` : ''));

  const sel = $('keyProvider');
  const choices = providers.map((p) => p.id);
  if (sel.dataset.sig !== choices.join(',')) {
    sel.innerHTML = choices.map((id) => `<option value="${esc(id)}">${esc(providerName(id))}</option>`).join('');
    sel.dataset.sig = choices.join(',');
  }
}

// ---------- adding keys ----------
// Accepts a pasted blob: one key per line (or comma separated), tolerates "Bearer " prefixes and quotes.
function parseKeys(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(/[\n,]+/)) {
    const key = part.trim().replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
    if (key && !seen.has(key)) { seen.add(key); out.push(key); }
  }
  return out;
}

$('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const keys = parseKeys($('keyValue').value);
  $('keyErr').textContent = '';
  if (keys.length === 0) { $('keyErr').textContent = 'Paste at least one key.'; return; }
  const short = keys.find((k) => k.length < 8);
  if (short) { $('keyErr').textContent = 'One of those keys is too short to be real.'; return; }
  try {
    await api('/api/keys', { method: 'POST', body: JSON.stringify({ provider: $('keyProvider').value, keys }) });
    $('keyValue').value = '';
    toast(`${keys.length} key${keys.length === 1 ? '' : 's'} added to ${providerName($('keyProvider').value)}`);
    await load();
  } catch (err) { $('keyErr').textContent = err.message; }
});

$('keyTestBtn').onclick = async () => {
  const keys = parseKeys($('keyValue').value);
  $('keyErr').textContent = '';
  if (keys.length === 0) { $('keyErr').textContent = 'Paste a key to test.'; return; }
  $('keyTestBtn').disabled = true;
  try {
    const out = await api('/api/providers/test', { method: 'POST', body: JSON.stringify({ provider: $('keyProvider').value, key: keys[0] }) });
    const r = out.results[0];
    $('keyErr').className = r.ok ? 'ok-msg' : 'err';
    $('keyErr').textContent = r.ok ? `That key works (${r.ms} ms). Nothing was saved yet.` : `That key did not work: ${r.error ?? r.errorKind ?? 'failed'}`;
  } catch (err) { $('keyErr').className = 'err'; $('keyErr').textContent = err.message; }
  finally { $('keyTestBtn').disabled = storageUnavailable; }
};

$('testAllBtn').onclick = async () => {
  $('testAllBtn').disabled = true;
  try {
    const out = await api('/api/providers/test', { method: 'POST', body: '{}' });
    for (const r of out.results) providerTests.set(r.provider, r);
    if (lastSnapshot) renderProviders(lastSnapshot);
    toast(`${out.results.filter((r) => r.ok).length} of ${out.results.length} keys work`);
  } catch (err) { fail(err); }
  finally { $('testAllBtn').disabled = false; }
};

// ---------- per-provider actions ----------
document.querySelector('[data-page="providers"]').addEventListener('click', async (e) => {
  const toggleKey = e.target.closest('button[data-key-toggle]');
  if (toggleKey) {
    try {
      await api('/api/keys', { method: 'PUT', body: JSON.stringify({ provider: toggleKey.dataset.keyToggle, label: toggleKey.dataset.label, enabled: toggleKey.dataset.enabled === '1' }) });
      toast(toggleKey.dataset.enabled === '1' ? 'Key turned on' : 'Key turned off');
      await load();
    } catch (err) { fail(err); }
    return;
  }
  const removeKey = e.target.closest('button[data-key-remove]');
  if (removeKey) {
    if (!confirm('Remove this key? Requests that used it will stop using it right away.')) return;
    try {
      await api('/api/keys', { method: 'DELETE', body: JSON.stringify({ provider: removeKey.dataset.keyRemove, label: removeKey.dataset.label }) });
      toast('Key removed');
      await load();
    } catch (err) { fail(err); }
    return;
  }
  const testKey = e.target.closest('button[data-test-provider]');
  if (testKey) {
    testKey.disabled = true;
    try {
      const out = await api('/api/providers/test', { method: 'POST', body: JSON.stringify({ provider: testKey.dataset.testProvider }) });
      for (const r of out.results) providerTests.set(r.provider, r);
      if (lastSnapshot) renderProviders(lastSnapshot);
    } catch (err) { fail(err); testKey.disabled = false; }
    return;
  }
  const laneTest = e.target.closest('button[data-lane-test]');
  if (laneTest) { laneTest.classList.add('busy'); await testProvider(laneTest.dataset.laneTest); laneTest.classList.remove('busy'); return; }
  const laneToggle = e.target.closest('button[data-lane-toggle]');
  if (laneToggle) {
    const p = (lastSnapshot?.providers || []).find((x) => x.id === laneToggle.dataset.laneToggle);
    if (!p) return;
    try {
      await putConfig({ providers: { [p.id]: { enabled: !p.enabled } } });
      toast(`${providerName(p.id)} turned ${p.enabled ? 'off' : 'on'}`);
    } catch (err) { fail(err); }
    return;
  }
  const laneKey = e.target.closest('button[data-lane-key]');
  if (laneKey) { $('keyProvider').value = laneKey.dataset.laneKey; $('keyValue').focus(); $('keyForm').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
});

// The Overview tiles reuse the same data attributes but live on another page.
document.querySelector('[data-page="overview"]').addEventListener('click', (e) => {
  if (e.target.closest('[data-lane-key]')) go('providers');
});

// ---------- custom endpoints (openai-compat) ----------
$('compatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('compatErr').textContent = '';
  try {
    const out = await api('/api/openai-compat/instances', {
      method: 'POST',
      body: JSON.stringify({ name: $('compatName').value, baseUrl: $('compatBaseUrl').value, apiKey: $('compatApiKey').value }),
    });
    $('compatForm').reset();
    renderCompatInstances(out.instances);
    $('probeResult').textContent = '';
    toast('Endpoint added');
    await load();
  } catch (err) { $('compatErr').textContent = err.message; }
});

$('compatProbeBtn').onclick = async () => {
  $('compatErr').textContent = '';
  $('probeResult').textContent = 'Probing';
  try {
    const out = await api('/api/openai-compat/probe', { method: 'POST', body: JSON.stringify({ baseUrl: $('compatBaseUrl').value, apiKey: $('compatApiKey').value || undefined }) });
    $('probeResult').textContent = out.ok
      ? `Reachable: ${out.count} models in ${out.ms} ms${out.models?.length ? `, for example ${out.models.slice(0, 3).join(', ')}` : ''}.`
      : `Not reachable: ${out.error || 'unknown error'} (${out.ms} ms)`;
  } catch (err) { $('probeResult').textContent = 'Failed: ' + err.message; }
};

function renderCompatInstances(instances) {
  setHtml($('compatInstances'), (instances || []).map((inst) => `<li class="mrow"><div class="mname"><code>${esc(inst.name)}</code><span class="muted">${esc(inst.baseUrl)}</span><span class="tag ${inst.enabled ? 'ok' : ''}">${inst.enabled ? 'on' : 'off'}</span></div>
      <div class="mact"><button data-compat-toggle="${esc(inst.prefix)}" data-enabled="${inst.enabled ? '0' : '1'}">${inst.enabled ? 'Turn off' : 'Turn on'}</button><button class="danger" data-compat-remove="${esc(inst.prefix)}">Remove</button></div></li>`).join('')
    || '<li class="empty-note">No custom endpoints yet.</li>');
}

$('compatInstances').addEventListener('click', async (e) => {
  const toggle = e.target.closest('button[data-compat-toggle]');
  if (toggle) {
    try { renderCompatInstances((await api('/api/openai-compat/instances', { method: 'PUT', body: JSON.stringify({ prefix: toggle.dataset.compatToggle, enabled: toggle.dataset.enabled === '1' }) })).instances); await load(); }
    catch (err) { $('compatErr').textContent = err.message; }
    return;
  }
  const remove = e.target.closest('button[data-compat-remove]');
  if (remove) {
    if (!confirm('Remove this endpoint and its stored key?')) return;
    try { renderCompatInstances((await api('/api/openai-compat/instances', { method: 'DELETE', body: JSON.stringify({ prefix: remove.dataset.compatRemove }) })).instances); await load(); }
    catch (err) { $('compatErr').textContent = err.message; }
  }
});
