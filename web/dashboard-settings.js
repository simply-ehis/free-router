/* PURPOSE: Dashboard settings page — router name/pool/aliases + layer toggles. Served at /dashboard-settings.js */
/* OWNS: everything behind the settings tab (loadSettings, aliases parsing, layers form submit) */
/* READ-WHEN: editing settings; shared helpers ($/api/esc/load/lastSnapshot) come from dashboard.js */
/* KEY-FILES: web/dashboard.html (DOM ids), web/dashboard.js (helpers/load), src/dashboard.mjs (config CRUD) */
/* INVARIANTS: zero deps; esc() every interpolation; config writes go through PUT /api/config validation */
/* GOTCHAS: dashboard.js is the loader — do not redeclare its globals; settings load on tab open, not per snapshot */
/* UPDATED: 2026-10-14 */
'use strict';

function aliasesToText(aliases) {
  return Object.entries(aliases || {}).map(([alias, target]) => `${alias} = ${target}`).join('\n');
}

function textToAliases(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function loadSettings() {
  try {
    const cfg = await api('/api/config');
    $('setName').value = cfg.name ?? '';
    $('setPool').value = cfg.selection?.pool ?? 'all';
    $('setDefaultModel').value = cfg.selection?.defaultModel ?? '';
    $('setAliases').value = aliasesToText(cfg.selection?.aliases);
    $('setStealth').checked = cfg.stealth?.enabled === true;
    $('setStealthAlias').value = cfg.stealth?.alias ?? '';
    $('setScrub').checked = cfg.stealth?.scrubContent === true;
    $('setPersona').checked = cfg.persona?.enabled === true;
    $('setDecision').checked = cfg.decision?.enabled === true;
    $('setCompaction').value = cfg.compaction?.strategy ?? 'summarize';
    $('setCatalogMinutes').value = cfg.refresh?.catalogMinutes ?? 10;
    $('setProbeMs').value = cfg.probe?.intervalMs ?? 120000;
    $('setStandby').value = cfg.probe?.standbyWarm ?? 2;
    const ids = [...new Set((lastSnapshot?.modelsDetail || []).map((m) => m.id))].sort();
    $('modelIds').innerHTML = ids.map((id) => `<option value="${esc(id)}"></option>`).join('');
  } catch (err) { $('settingsMsg').textContent = err.message; }
  loadScoring().catch((err) => { $('weightsMsg').textContent = err.message; });
}

// ---------- scoring studio ----------
const WEIGHT_HELP = {
  success: 'recent success rate (Laplace-smoothed ok vs fail)',
  latency: 'measured latency on a 0-5s scale',
  freshness: 'how recently the model answered a probe',
  priority: 'per-model pin from the Models tab (neutral 0.5)',
  verified: 'free-tier evidence in the catalog (only counts when evidence exists)',
};
let weightState = { defaults: {}, models: [] };

function currentWeightValues() {
  const out = {};
  for (const c of Object.keys(weightState.defaults)) {
    const el = $('w_' + c);
    if (el) out[c] = Number(el.value);
  }
  return out;
}

// Client-side copy of the engine's renormalized weighted mean over the
// model's active components — same math, so the preview matches real routing.
function scoreWithWeights(m, w) {
  const keys = Object.keys(m.components ?? {});
  const total = keys.reduce((sum, k) => sum + (w[k] ?? 0), 0);
  if (!total) return 0;
  return keys.reduce((sum, k) => sum + m.components[k] * (w[k] ?? 0), 0) / total;
}

function renderWeightsPreview() {
  const w = currentWeightValues();
  const ranked = weightState.models
    .map((m) => ({ id: m.id, score: Math.round(scoreWithWeights(m, w) * 100) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 5);
  $('weightsPreview').innerHTML = ranked.length
    ? ranked.map((m, i) => `<div class="weight-row"><span class="muted">${i + 1}.</span> <code>${esc(m.id)}</code> <span class="badge score">${m.score}</span></div>`).join('')
    : '<div class="muted">no models in the catalog yet</div>';
}

async function loadScoring() {
  const snap = await api('/api/scoring');
  weightState = { defaults: snap.defaults, models: snap.models };
  $('weightSliders').innerHTML = snap.components.map((c) => {
    const v = snap.weights[c] ?? snap.defaults[c];
    return `<div class="weight-row"><label for="w_${c}" title="${esc(WEIGHT_HELP[c] || c)}">${c}</label>`
      + `<input type="range" id="w_${c}" min="0" max="1" step="0.05" value="${v}">`
      + `<output id="wv_${c}">${Number(v).toFixed(2)}</output></div>`;
  }).join('');
  for (const c of snap.components) {
    $('w_' + c).addEventListener('input', () => {
      $('wv_' + c).textContent = Number($('w_' + c).value).toFixed(2);
      renderWeightsPreview();
    });
  }
  renderWeightsPreview();
}

$('weightsSave').onclick = async () => {
  try {
    const out = await api('/api/scoring/weights', { method: 'POST', body: JSON.stringify({ weights: currentWeightValues() }) });
    weightState.models = out.models;
    toast('scoring weights saved ✓');
    $('weightsMsg').textContent = '';
  } catch (err) { $('weightsMsg').textContent = 'Error → ' + err.message; }
};
$('weightsReset').onclick = () => {
  for (const [c, v] of Object.entries(weightState.defaults)) {
    const el = $('w_' + c);
    if (el) { el.value = v; $('wv_' + c).textContent = Number(v).toFixed(2); }
  }
  renderWeightsPreview();
};

$('layersForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('settingsMsg').textContent = '';
  const patch = {
    name: $('setName').value.trim() || 'free-router',
    selection: {
      pool: $('setPool').value,
      defaultModel: $('setDefaultModel').value.trim(),
      aliases: textToAliases($('setAliases').value),
    },
    stealth: { enabled: $('setStealth').checked, alias: $('setStealthAlias').value.trim() || 'cloud-1', scrubContent: $('setScrub').checked },
    persona: { enabled: $('setPersona').checked },
    decision: { enabled: $('setDecision').checked },
    compaction: { strategy: $('setCompaction').value },
    refresh: { catalogMinutes: Number($('setCatalogMinutes').value) || 10 },
    probe: { intervalMs: Number($('setProbeMs').value) || 120000, standbyWarm: Number($('setStandby').value) || 0 },
  };
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
    $('settingsMsg').textContent = 'saved ✓';
    setTimeout(() => { if ($('settingsMsg').textContent === 'saved ✓') $('settingsMsg').textContent = ''; }, 4000);
    await load();
  } catch (err) { $('settingsMsg').textContent = 'Error → ' + err.message; }
});
