// @body:organ=muscle type=strategy role="sticky: keep the previous route until it fails, then fall back through smartest-ranked alternatives"
import { scoreModel } from './smartest.mjs';

export default {
  name: 'sticky',
  order(ctx) {
    const ids = ctx.models.map((m) => m.id);
    const prev = ctx.previous?.modelId;
    const head = prev && ids.includes(prev) ? [prev] : [];
    // Failover order after the pinned route is evidence-ranked: the best-scored
    // healthy alternative goes next instead of raw listing order.
    const rest = ids
      .filter((id) => !head.includes(id))
      .sort((a, b) => scoreModel(b, ctx) - scoreModel(a, ctx) || a.localeCompare(b));
    return [...head, ...rest];
  },
};
