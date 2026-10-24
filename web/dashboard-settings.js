/* PURPOSE: Dashboard settings page — one form (routing, model filtering, layers, background checks) with unsaved-changes tracking, plus the scoring studio. Served at /dashboard-settings.js */
/* OWNS: everything behind the settings tab (loadSettings, validation, dirty bar, alias parsing, scoring sliders) */
/* READ-WHEN: editing settings; shared helpers ($/api/esc/toast/fail/lastSnapshot) come from dashboard.js */
/* KEY-FILES: web/dashboard.html (DOM ids), web/dashboard.js (helpers), src/dashboard.mjs (PUT /api/config validates and persists) */
/* INVARIANTS: esc() every interpolation; malformed lines are reported, never silently dropped; saving waits for the server's answer and then re-reads the stored config, so the form always shows what is really saved */
/* GOTCHAS: settings load on tab open, not per snapshot — typing must not be overwritten every 2s; leaving with unsaved changes asks first */
/* UPDATED: 2026-10-22 */
'use strict';

let settingsDirty = false;
let settingsBaseline = null;

function aliasesToText(aliases) {
  return Object.entries(aliases || {}).map(([alias, target]) => `${alias} = ${target}`).join('\n');
}

// Returns { aliases, bad } — bad lists lines that could not be understood.
function parseAliases(text) {
  const aliases = {};
  const bad = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*=\s*(\S.*?)\s*$/.exec(line);
    if (m) aliases[m[1]] = m[2]; else bad.push(line.trim());
  }
  return { aliases, bad };
}

function lines(text) {
  return [...new Set(String(text || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))];
}

function markDirty(dirty) {
  settingsDirty = dirty;
  $('saveBar').classList.toggle('dirty', dirty);
  $('settingsMsg').className = dirty ? '' : 'ok-msg';
  if (dirty) $('settingsMsg').textContent = 'You have unsaved changes.';
}

function fillSettings(cfg) {
  $('setName').value = cfg.name ?? '';
  $('setPool').value = cfg.selection?.pool ?? 'all';
  $('setDefaultModel').value = cfg.selection?.defaultModel ?? '';
  $('setAliases').value = aliasesToText(cfg.selection?.aliases);
  $('setForceChat').value = (cfg.selection?.forceChat || []).join('\n');
  $('setStealth').checked = cfg.stealth?.enabled === true;
  $('setStealthAlias').value = cfg.stealth?.alias ?? '';
  $('setScrub').checked = cfg.stealth?.scrubContent === true;
  $('setPersona').checked = cfg.persona?.enabled === true;
  $('setDecision').checked = cfg.decision?.enabled === true;
  $('setCompaction').value = cfg.compaction?.strategy ?? 'summarize';
  $('setCatalogMinutes').value = cfg.refresh?.catalogMinutes ?? 10;
  $('setProbeSec').value = Math.round((cfg.probe?.intervalMs ?? 120000) / 1000);
  $('setStandby').value = cfg.probe?.standbyWarm ?? 2;
  $('setSweepMin').value = Math.round((cfg.probe?.sweepIntervalMs ?? 3600000) / 60000);
  settingsBaseline = cfg;
  markDirty(false);
}

async function loadSettings() {
  if (settingsDirty) return; // never overwrite edits in progress
  try {
    fillSettings(await api('/api/config'));
    $('settingsMsg').textContent = '';
  } catch (err) { if (err.message !== 'Sign in required') { $('settingsMsg').className = 'err'; $('settingsMsg').textContent = err.message; } }
  loadScoring().catch((err) => { $('weightsMsg').textContent = err.message; });
}

function intField(id, label, { min, max }) {
  const raw = $(id).value.trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${label} must be a whole number.`);
  if (n < min || (max != null && n > max)) throw new Error(`${label} must be ${max != null ? `between ${min} and ${max}` : `at least ${min}`}.`);
  return n;
}

function buildPatch() {
  const { aliases, bad } = parseAliases($('setAliases').value);
  if (bad.length) throw new Error(`These alias lines are not in "alias = model-id" form: ${bad.slice(0, 3).join('; ')}`);
  return {
    name: $('setName').value.trim() || 'free-router',
    selection: { pool: $('setPool').value, defaultModel: $('setDefaultModel').value.trim(), aliases, forceChat: lines($('setForceChat').value) },
    stealth: { enabled: $('setStealth').checked, alias: $('setStealthAlias').value.trim() || 'cloud-1', scrubContent: $('setScrub').checked },
    persona: { enabled: $('setPersona').checked },
    decision: { enabled: $('setDecision').checked },
    compaction: { strategy: $('setCompaction').value },
    refresh: { catalogMinutes: intField('setCatalogMinutes', 'Catalog refresh', { min: 1 }) },
    probe: {
      intervalMs: intField('setProbeSec', 'Check interval', { min: 1 }) * 1000,
      standbyWarm: intField('setStandby', 'Standby models', { min: 0, max: 10 }),
      sweepIntervalMs: intField('setSweepMin', 'Full model test interval', { min: 1 }) * 60000,
    },
  };
}

$('settingsForm').addEventListener('input', () => markDirty(true));
$('settingsForm').addEventListener('change', () => markDirty(true));
$('settingsRevert').onclick = () => { if (settingsBaseline) fillSettings(settingsBaseline); };
window.addEventListener('beforeunload', (e) => { if (settingsDirty) { e.preventDefault(); e.returnValue = ''; } });

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('settingsMsg').className = 'err';
  $('settingsMsg').textContent = '';
  let patch;
  try { patch = buildPatch(); } catch (err) { $('settingsMsg').textContent = err.message; return; }
  $('settingsSave').disabled = true;
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
    fillSettings(await api('/api/config')); // show what the server really stored
    $('settingsMsg').className = 'ok-msg';
    $('settingsMsg').textContent = 'Saved. The pool was refreshed with your changes.';
    toast('Settings saved');
    await load();
  } catch (err) { $('settingsMsg').textContent = err.message; }
  finally { $('settingsSave').disabled = false; }
});

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

