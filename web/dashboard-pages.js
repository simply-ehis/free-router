/* PURPOSE: Dashboard pages — providers + custom endpoints + security (client keys). Served at /dashboard-pages.js */
/* OWNS: everything behind the providers and security tabs */
/* READ-WHEN: editing providers/custom endpoints/security; other pages live in dashboard-{models,analytics,settings}.js */
/* KEY-FILES: web/dashboard.html (DOM ids), web/dashboard.js (api/esc/log/fail helpers, renderSnapshot), src/dashboard.mjs (endpoints) */
/* INVARIANTS: zero deps; esc() every interpolation; secrets rendered only once at creation; pages render from sanitized snapshots only */
/* GOTCHAS: dashboard.js is the loader — globals $/api/esc/log/fail/act/dropKey/renderSnapshot/load/lastSnapshot come from there; this file must not redeclare them */
/* UPDATED: 2026-10-14 */
'use strict';

// Last key-test result per provider; survives the 2s snapshot rebuilds.
const providerTests = new Map();

// ---------- providers page ----------
function testBadge(provider) {
  const t = providerTests.get(provider);
  if (!t) return '';
  if (t.ok) return `<span class="badge ok" title="ping via ${esc(t.model)} with key ${esc(t.keyMasked ?? '?')} (${esc(t.keySource)})">✓ ${t.ms} ms</span>`;
  const tip = `${esc(t.error ?? 'fail')}${t.model ? ` (tested model: ${esc(t.model)})` : ''}`;
  return `<span class="badge bad" title="${tip}">✗ ${esc(t.errorKind || 'fail')}</span>`;
}
function renderCompatFormState(unavailable) {
  for (const id of ['compatName', 'compatBaseUrl', 'compatApiKey', 'compatProbeBtn']) {
    const el = $(id);
    if (el) el.disabled = !!unavailable;
  }
  const note = $('compatErr');
  if (note && unavailable) note.textContent = 'Cloudflare credential storage is not configured — set COMPAT_CREDENTIALS_KEY first.';
  else if (note && note.textContent.startsWith('Cloudflare credential storage')) note.textContent = '';
}

function renderKeyFormState(unavailable) {
  for (const id of ['keyProvider', 'keyValue']) {
    const el = $(id);
    if (el) el.disabled = !!unavailable;
  }
  const btn = document.querySelector('#keyForm button');
  if (btn) btn.disabled = !!unavailable;
  const note = $('keyErr');
  if (note && unavailable) note.textContent = 'Cloudflare credential storage is not configured — set COMPAT_CREDENTIALS_KEY first.';
  else if (note && note.textContent.startsWith('Cloudflare credential storage')) note.textContent = '';
}

function providerRow(p) {
  const auto = p.discovered ? ` <span class="muted">${p.discovered} auto-discovered</span>` : '';
  const off = p.enabled ? '' : ' <span class="badge dim">disabled</span>';
  const test = p.id === 'openai-compat' ? '' : ` <button data-test-provider="${esc(p.id)}" title="minimal authenticated ping with the newest key">test</button> ${testBadge(p.id)}`;
  const toggle = p.id === 'openai-compat' ? ''
    : ` <button data-provider-toggle="${esc(p.id)}" data-enabled="${p.enabled ? '0' : '1'}">${p.enabled ? 'disable' : 'enable'}</button>`;
  const drop = (p.configured ?? p.keys) > 0 ? ` <button class="danger" data-action="dropkey" data-provider="${esc(p.id)}">drop last key</button>` : '';
  return `<tr><td>${esc(p.id)}${off}</td><td>${p.keys}${auto}</td><td class="actions">${test}${toggle}${drop}</td></tr>`;
}

function renderProviders(s) {
  renderKeyFormState(s.runtimePlatform === 'worker' && !s.providerKeysReady);
  const providers = s.providers || [];
  $('providers').innerHTML = providers.map(providerRow).join('') || '<tr><td colspan="3" class="muted">no providers configured</td></tr>';
  const sel = $('keyProvider');
  const choices = providers.filter((p) => p.id !== 'openai-compat').map((p) => p.id);
  if (sel.dataset.sig !== choices.join(',')) {
    sel.innerHTML = choices.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
    sel.dataset.sig = choices.join(',');
  }
}

$('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('keyValue').value.trim();
  $('keyErr').textContent = '';
  $('keyErr').className = 'err';
  if (!value) { $('keyErr').textContent = 'Enter a key first.'; return; }
  try {
    await api('/api/keys', { method: 'POST', body: JSON.stringify({ provider: $('keyProvider').value, keys: [value] }) });
    $('keyValue').value = '';
    await load();
  } catch (err) { $('keyErr').textContent = err.message; }
});

// Test-before-save: validate a pasted key against the provider without persisting it.
$('keyTestBtn').onclick = async () => {
  const value = $('keyValue').value.trim();
  $('keyErr').className = 'err';
  if (!value) { $('keyErr').textContent = 'Enter a key first.'; return; }
  $('keyTestBtn').disabled = true;
  $('keyErr').textContent = 'testing key…';
  try {
    const out = await api('/api/providers/test', { method: 'POST', body: JSON.stringify({ provider: $('keyProvider').value, key: value }) });
    const r = out.results[0];
    if (r?.ok) {
      providerTests.set(r.provider, r);
      $('keyErr').className = 'ok-msg';
      $('keyErr').textContent = `✓ key works — ping ${r.model} in ${r.ms} ms (${r.keyMasked})`;
    } else {
      $('keyErr').textContent = `✗ ${r?.error ?? 'test failed'}${r?.errorKind ? ` (${r.errorKind})` : ''}`;
    }
    if (lastSnapshot) renderProviders(lastSnapshot);
  } catch (err) { $('keyErr').textContent = err.message; }
  finally { $('keyTestBtn').disabled = false; }
};

$('testAllBtn').onclick = async () => {
  $('testAllBtn').disabled = true;
  try {
    const out = await api('/api/providers/test', { method: 'POST', body: '{}' });
    for (const r of out.results) providerTests.set(r.provider, r);
    if (lastSnapshot) renderProviders(lastSnapshot);
  } catch (err) { fail(err); }
  finally { $('testAllBtn').disabled = false; }
};

document.addEventListener('click', async (e) => {
  const drop = e.target.closest('button[data-action="dropkey"]');
  if (drop) { dropKey(drop.dataset.provider); return; }
  const testBtn = e.target.closest('button[data-test-provider]');
  if (testBtn) {
    const provider = testBtn.dataset.testProvider;
    testBtn.disabled = true;
    try {
      const out = await api('/api/providers/test', { method: 'POST', body: JSON.stringify({ provider }) });
      for (const r of out.results) providerTests.set(r.provider, r);
    } catch (err) { fail(err); }
    finally { testBtn.disabled = false; }
    if (lastSnapshot) renderProviders(lastSnapshot);
    return;
  }
  const toggle = e.target.closest('button[data-provider-toggle]');
  if (toggle) {
    try {
      await api('/api/config', { method: 'PUT', body: JSON.stringify({ providers: { [toggle.dataset.providerToggle]: { enabled: toggle.dataset.enabled === '1' } } }) });
      await load();
    } catch (err) { fail(err); }
  }
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
    if (out.status) renderSnapshot(out.status);
    await load();
  } catch (err) { $('compatErr').textContent = err.message; }
});

$('compatProbeBtn').onclick = async () => {
  $('compatErr').textContent = '';
  $('probeResult').textContent = 'probing…';
  try {
    const out = await api('/api/openai-compat/probe', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: $('compatBaseUrl').value, apiKey: $('compatApiKey').value || undefined }),
    });
    $('probeResult').textContent = out.ok
      ? `reachable — ${out.count} models in ${out.ms} ms` + (out.models.length ? `: ${out.models.slice(0, 5).join(', ')}${out.count > 5 ? '…' : ''}` : '')
      : `failed — ${out.error} (${out.ms} ms)`;
  } catch (err) { $('probeResult').textContent = 'failed — ' + err.message; }
};

function renderCompatInstances(instances) {
  $('compatInstances').innerHTML = (instances || []).map((inst) => {
    const state = inst.enabled ? '<span class="badge ok">on</span>' : '<span class="badge dim">off</span>';
    return `<tr><td>${esc(inst.name)} <span class="muted">${esc(inst.prefix)}</span></td><td class="muted">${esc(inst.baseUrl)}</td><td>${state}</td>`
      + `<td class="actions"><button data-compat-toggle="${esc(inst.prefix)}" data-enabled="${inst.enabled ? '0' : '1'}">${inst.enabled ? 'disable' : 'enable'}</button>`
      + ` <button class="danger" data-compat-remove="${esc(inst.prefix)}">remove</button></td></tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">no custom endpoints yet</td></tr>';
}

document.addEventListener('click', async (e) => {
  const toggle = e.target.closest('button[data-compat-toggle]');
  if (toggle) {
    try {
      const out = await api('/api/openai-compat/instances', { method: 'PUT', body: JSON.stringify({ prefix: toggle.dataset.compatToggle, enabled: toggle.dataset.enabled === '1' }) });
      if (out.status) renderSnapshot(out.status);
      await load();
    } catch (err) { $('compatErr').textContent = err.message; }
    return;
  }
  const remove = e.target.closest('button[data-compat-remove]');
  if (remove) {
    if (!confirm('Remove this custom endpoint? Its models disappear from the pool.')) return;
    try {
      const out = await api('/api/openai-compat/instances', { method: 'DELETE', body: JSON.stringify({ prefix: remove.dataset.compatRemove }) });
      if (out.status) renderSnapshot(out.status);
      await load();
    } catch (err) { $('compatErr').textContent = err.message; }
  }
});

// ---------- security page ----------
function renderSecurity(s) {
  const sec = s.security || {};
  const ipList = (sec.allowedIps || []).join(', ') || 'any';
  $('secCards').innerHTML = [
    ['rate limit', `${sec.rateLimitPerMin ?? '-'}/min`],
    ['allowed IPs', ipList],
    ['client keys', ($('clientKeys')?.children.length ?? 0)],
  ].map(([label, v]) => `<div class="card"><b class="small">${esc(v)}</b><span>${label}</span></div>`).join('');
}

function renderClientKeys(keys) {
  $('clientKeys').innerHTML = (keys || []).map((k) => {
    const created = k.createdAt ? new Date(k.createdAt).toLocaleDateString() : '-';
    return `<tr><td>${esc(k.label)}</td><td class="muted">${esc(created)}</td>`
      + `<td class="actions"><button class="danger" data-client-revoke="${esc(k.id)}">revoke</button></td></tr>`;
  }).join('') || '<tr><td colspan="3" class="muted">no client keys yet</td></tr>';
}

$('clientKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('clientKeyErr').textContent = '';
  try {
    const out = await api('/api/client-keys', { method: 'POST', body: JSON.stringify({ name: $('clientKeyName').value }) });
    $('clientKeyName').value = '';
    $('clientKeyValue').value = out.key;
    $('clientKeyOnce').classList.remove('hidden');
    renderClientKeys(out.keys);
    log('client key created — copy it now, it is not shown again');
  } catch (err) { $('clientKeyErr').textContent = err.message; }
});

$('copyClientKey').onclick = () => {
  navigator.clipboard?.writeText($('clientKeyValue').value).then(() => { $('copyClientKey').textContent = 'copied'; setTimeout(() => { $('copyClientKey').textContent = 'copy key'; }, 1200); });
};

document.addEventListener('click', async (e) => {
  const revoke = e.target.closest('button[data-client-revoke]');
  if (!revoke) return;
  if (!confirm('Revoke this client key? Clients using it stop working immediately.')) return;
  try {
    const out = await api('/api/client-keys', { method: 'DELETE', body: JSON.stringify({ id: revoke.dataset.clientRevoke }) });
    renderClientKeys(out.keys);
  } catch (err) { $('clientKeyErr').textContent = err.message; }
});
