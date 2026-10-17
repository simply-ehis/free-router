// @body:nerve=strategies — every strategy registers here and ONLY here
import sticky from './sticky.mjs';
import fastest from './fastest.mjs';
import roundrobin from './roundrobin.mjs';
import smartest from './smartest.mjs';

export const registry = { sticky, fastest, roundrobin, smartest };
export { scoreModel, scoreBreakdown, BASE_WEIGHTS as DEFAULT_WEIGHTS, COMPONENTS as SCORE_COMPONENTS } from './smartest.mjs';
const DEFAULT = 'sticky';

function sanitize(ids, ctx) {
  const valid = new Set(ctx.models.map((m) => m.id));
  const out = [];
  const seen = new Set();
  for (const id of ids ?? []) {
    if (valid.has(id) && !seen.has(id)) { out.push(id); seen.add(id); }
  }
  for (const m of ctx.models) if (!seen.has(m.id)) out.push(m.id);
  return out;
}

// Selection is async and time-boxed: a slow/broken strategy can never stall routing.
// Fallback = candidate order as built by the engine (health-filtered insertion order).
export async function select(cfg, ctx) {
  const name = cfg?.selection?.strategy ?? DEFAULT;
  const strat = registry[name] ?? registry[DEFAULT];
  try {
    const timeboxMs = cfg?.selection?.timeboxMs ?? 700;
    const ids = await Promise.race([
      Promise.resolve().then(() => strat.order(ctx)),
      new Promise((_, rej) => {
        const t = setTimeout(() => rej(new Error('strategy-timeout')), timeboxMs);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
    return sanitize(ids, ctx);
  } catch {
    return sanitize(ctx.models.map((m) => m.id), ctx);
  }
}
