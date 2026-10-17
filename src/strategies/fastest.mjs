// @body:organ=muscle type=strategy role="fastest: order by EWMA latency ascending"
export default {
  name: 'fastest',
  order(ctx) {
    const latency = (id) => ctx.states.get(id)?.latencyMs ?? Number.POSITIVE_INFINITY;
    return ctx.models
      .map((m) => m.id)
      .sort((a, b) => latency(a) - latency(b) || a.localeCompare(b));
  },
};
