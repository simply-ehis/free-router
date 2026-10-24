// @body:organ=face type=dashboard role="scoring studio: weight validation + per-model score breakdown from live catalog/routes state; single math path shared with the smartest strategy"
import { getState as getCatalog } from './catalog.mjs';
import { getRoutesState, modelStatus } from './routes.mjs';
import { scoreBreakdown, DEFAULT_WEIGHTS, SCORE_COMPONENTS } from './strategies/index.mjs';
import { saveConfig } from './config.mjs';

const round2 = (v) => Math.round(v * 100) / 100;

export function scoringSnapshot(cfg) {
  const catalog = getCatalog();
  const stateById = new Map(getRoutesState().models.map((m) => [m.id, m]));
  const ctx = { cfg, states: stateById, sources: new Map(catalog.models.map((m) => [m.id, m.sources])) };
  const models = catalog.models.map((m) => {
    const b = scoreBreakdown(m.id, ctx);
    return {
      id: m.id,
      provider: m.provider,
      status: modelStatus(m.id),
      score: Math.round(b.score * 100),
      components: Object.fromEntries(Object.entries(b.components).map(([k, v]) => [k, round2(v)])),
      weights: b.weights,
    };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    strategy: cfg.selection?.strategy ?? 'sticky',
    components: SCORE_COMPONENTS,
    defaults: DEFAULT_WEIGHTS,
    weights: { ...DEFAULT_WEIGHTS, ...(cfg.selection?.weights ?? {}) },
    models,
  };
}

export function setScoringWeights(cfg, weights) {
  if (weights === null || typeof weights !== 'object' || Array.isArray(weights)) return { error: '`weights` must be an object' };
  for (const key of Object.keys(weights)) {
    if (!SCORE_COMPONENTS.includes(key)) return { error: `unknown weight component: ${key}` };
  }
  const clean = {};
  for (const key of SCORE_COMPONENTS) {
    const v = weights[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return { error: `weights.${key} must be a number between 0 and 1` };
    clean[key] = v;
  }
  const merged = { ...DEFAULT_WEIGHTS, ...(cfg.selection?.weights ?? {}), ...clean };
  if (SCORE_COMPONENTS.every((k) => (merged[k] ?? 0) === 0)) return { error: 'at least one weight must be greater than 0' };
  cfg.selection.weights = merged;
  saveConfig(cfg);
  return { weights: merged };
}
