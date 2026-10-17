// @body:organ=muscle type=strategy role="smartest: success × latency × free-verified evidence, re-weighted by decision-plane complexity hints"
export const BASE_WEIGHTS = { success: 0.4, latency: 0.3, freshness: 0.15, priority: 0.05, verified: 0.1 };
export const COMPONENTS = ['success', 'latency', 'freshness', 'priority', 'verified'];

export default {
  name: 'smartest',
  async order(ctx) {
    const w = ctx.cfg?.selection?.weights ?? {};
    const baseSuccess = w.success ?? BASE_WEIGHTS.success;
    const baseLatency = w.latency ?? BASE_WEIGHTS.latency;

    // Prefilled decision hints (internally time-boxed): complexity 0..3 shifts
    // weight toward reliability (complex) or speed (trivial). Absent/late hints
    // → neutral baseline, identical to pre-P5 behavior.
    let hints = null;
    if (ctx.decisionHints) {
      try { hints = await ctx.decisionHints; } catch { hints = null; }
    }
    const shift = hints && typeof hints.complexity === 'number'
      ? (Math.min(3, Math.max(0, hints.complexity)) - 1.5) / 6
      : 0;
    const weights = {
      ...w,
      success: Math.max(0, baseSuccess * (1 + shift)),
      latency: Math.max(0, baseLatency * (1 - shift)),
    };
    return ctx.models
      .map((m) => m.id)
      .sort((a, b) => scoreModel(b, ctx, weights) - scoreModel(a, ctx, weights) || a.localeCompare(b));
  },
};

// `verified` is scored only when the caller carries free-tier evidence
// (ctx.sources from the catalog). Without it the component is dropped and the
// remaining weights renormalize — a caller that cannot know never gets guessed.
// Single source of truth for the math: scoreModel is the thin numeric view,
// scoreBreakdown the explainable view the scoring studio renders.
export function scoreBreakdown(id, ctx, weights = ctx.cfg?.selection?.weights ?? BASE_WEIGHTS) {
  const s = ctx.states.get(id) ?? {};
  const total = (s.ok ?? 0) + (s.fail ?? 0);
  const evidence = ctx.sources instanceof Map ? ctx.sources.get(id) : undefined;
  const components = {
    success: total > 0 ? ((s.ok ?? 0) + 1) / (total + 2) : 0.5,
    latency: s.latencyMs == null ? 0.3 : Math.max(0, 1 - s.latencyMs / 5000),
    freshness: s.lastProbeAt
      ? Math.max(0, 1 - (Date.now() - s.lastProbeAt) / Math.max(1, (ctx.cfg?.probe?.intervalMs ?? 120000) * 3))
      : 0.5,
    priority: Number.isFinite(ctx.cfg?.selection?.priorities?.[id])
      ? Math.min(1, Math.max(0, ctx.cfg.selection.priorities[id]))
      : 0.5,
    verified: Array.isArray(evidence) ? (evidence.length > 0 ? 1 : 0.25) : null,
  };
  const active = COMPONENTS.filter((key) => components[key] !== null);
  const weightOf = (key) => (Number.isFinite(weights?.[key]) && weights[key] >= 0 ? weights[key] : BASE_WEIGHTS[key]);
  const used = Object.fromEntries(active.map((key) => [key, weightOf(key)]));
  const totalWeight = active.reduce((sum, key) => sum + used[key], 0);
  const score = totalWeight ? active.reduce((sum, key) => sum + components[key] * used[key], 0) / totalWeight : 0;
  return {
    score,
    components: Object.fromEntries(active.map((key) => [key, components[key]])),
    weights: used,
  };
}

export function scoreModel(id, ctx, weights = ctx.cfg?.selection?.weights ?? BASE_WEIGHTS) {
  return scoreBreakdown(id, ctx, weights).score;
}
