/* PURPOSE: Dashboard security page — warnings, access limits (rate limit / IP allow-list / session length), sign out everywhere, client API keys. Served at /dashboard-security.js */
/* OWNS: everything behind the Security tab */
/* READ-WHEN: editing access controls or client keys; endpoints live in src/dashboard.mjs, auth in src/dashboardAuth.mjs */
/* KEY-FILES: web/dashboard.html (DOM ids), web/dashboard.js (api/esc/toast helpers), src/security.mjs (securityState + warnings) */
/* INVARIANTS: esc() every interpolation; a new client key is shown exactly once, never re-rendered from the snapshot; the allow-list form warns before it can lock the owner out */
/* GOTCHAS: the form fields are filled once per visit (loadSecurity), not on every snapshot, or typing would be overwritten every 2s */
/* UPDATED: 2026-10-22 */
'use strict';

let myIp = '';
let usageByKey = new Map();
let accessDirty = false;

function renderSecurity(s) {
  const sec = s.security || {};
  const warns = (sec.warnings || []).map((w) => `<div class="warnline">${esc(w)}</div>`).join('');
  setHtml($('secWarnings'), warns || '<div class="goodline">No problems found with the current settings.</div>');
  const ips = (sec.allowedIps || []);
  setHtml($('secFacts'), `<dt>Rate limit</dt><dd>${sec.rateLimitPerMin ? `${sec.rateLimitPerMin} requests per minute per IP` : 'Off'}</dd>
    <dt>Who can connect</dt><dd>${ips.length ? esc(ips.join(', ')) : 'Any address'}</dd>
    <dt>Sign-in</dt><dd>Session cookie, ${sec.sessionHours} hours. ${sec.maxLoginFailures} wrong passwords lock that address for a minute, then longer.</dd>
    <dt>Dashboard runs on</dt><dd>${s.runtimePlatform === 'worker' ? 'Cloudflare Workers' : 'Node'}</dd>`);
  if (!accessDirty && document.activeElement?.closest?.('#accessForm') == null) fillAccessForm(sec);
}

function fillAccessForm(sec) {
  $('secRate').value = sec.rateLimitPerMin ?? 60;
  $('secIps').value = (sec.allowedIps || []).join('\n');
  $('secSession').value = sec.sessionHours ?? 12;
  $('secFailures').value = sec.maxLoginFailures ?? 5;
}

async function loadSecurity() {
  try {
    myIp = (await api('/api/whoami')).ip || '';
    $('yourIp').textContent = myIp || 'unknown';
    usageByKey = new Map(((await api('/api/usage')).keys || []).map((k) => [k.label, k]));
    renderClientKeys(lastClientKeys);
  } catch (e) { fail(e); }
}

$('accessForm').addEventListener('input', () => { accessDirty = true; $('accessMsg').textContent = ''; });
$('addMyIp').onclick = () => {
  if (!myIp) return;
  const list = $('secIps').value.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!list.includes(myIp)) list.push(myIp);
  $('secIps').value = list.join('\n');
  accessDirty = true;
};

$('accessForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ips = $('secIps').value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  if (ips.length > 0 && myIp && !ips.includes(myIp)
    && !confirm(`Your current address (${myIp}) is not on this list. Saving will lock you out of the dashboard and the API from here. Save anyway?`)) return;
  try {
    await putConfig({ security: { rateLimitPerMin: Number($('secRate').value), allowedIps: ips, sessionHours: Number($('secSession').value), maxLoginFailures: Number($('secFailures').value) } });
    accessDirty = false;
    $('accessMsg').textContent = 'Saved.';
    toast('Access limits saved');
  } catch (err) { $('accessMsg').textContent = ''; fail(err); }
});

$('signOutAll').onclick = async () => {
  if (!confirm('Sign out every device, including this one?')) return;
  try { await api('/api/logout-all', { method: 'POST', body: '{}' }); } catch (e) { if (e.message !== 'Sign in required') { fail(e); return; } }
  showLogin('Signed out everywhere. Sign in again.');
};

// ---------- client keys ----------
let lastClientKeys = [];

function renderClientKeys(keys) {
  lastClientKeys = keys || [];
  setHtml($('clientKeys'), lastClientKeys.map((k) => {
    const used = usageByKey.get(k.label);
    const when = k.createdAt ? new Date(k.createdAt).toLocaleDateString() : 'unknown date';
    return `<li class="mrow"><div class="mname"><code>${esc(k.label)}</code><span class="tag ${k.enabled ? 'ok' : ''}">${k.enabled ? 'active' : 'paused'}</span><span class="muted">created ${esc(when)}${used ? `, ${used.requests} requests, last used ${esc(ago(used.lastAt))}` : ''}</span></div>
      <div class="mact"><button data-ck-toggle="${esc(k.id)}" data-enabled="${k.enabled ? '0' : '1'}">${k.enabled ? 'Pause' : 'Resume'}</button><button class="danger" data-ck-revoke="${esc(k.id)}">Revoke</button></div></li>`;
  }).join('') || '<li class="empty-note">No client keys yet. Create one to connect an app.</li>');
}

$('clientKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('clientKeyErr').textContent = '';
  try {
    const out = await api('/api/client-keys', { method: 'POST', body: JSON.stringify({ name: $('clientKeyName').value }) });
    $('clientKeyName').value = '';
    $('clientKeyValue').value = out.key;
    $('clientKeyOnce').classList.remove('hidden');
    $('clientKeyValue').select();
    renderClientKeys(out.keys);
    toast('Key created. Copy it now.');
  } catch (err) { $('clientKeyErr').textContent = err.message; }
});

$('copyClientKey').onclick = () => copyText($('clientKeyValue').value, $('copyClientKey'));

$('clientKeys').addEventListener('click', async (e) => {
  const toggle = e.target.closest('button[data-ck-toggle]');
  if (toggle) {
    try { renderClientKeys((await api('/api/client-keys', { method: 'PUT', body: JSON.stringify({ id: toggle.dataset.ckToggle, enabled: toggle.dataset.enabled === '1' }) })).keys); toast(toggle.dataset.enabled === '1' ? 'Key resumed' : 'Key paused'); }
    catch (err) { $('clientKeyErr').textContent = err.message; }
    return;
  }
  const revoke = e.target.closest('button[data-ck-revoke]');
  if (!revoke) return;
  if (!confirm('Revoke this client key? Apps using it stop working immediately, and it cannot be brought back.')) return;
  try { renderClientKeys((await api('/api/client-keys', { method: 'DELETE', body: JSON.stringify({ id: revoke.dataset.ckRevoke }) })).keys); toast('Key revoked'); }
  catch (err) { $('clientKeyErr').textContent = err.message; }
});
