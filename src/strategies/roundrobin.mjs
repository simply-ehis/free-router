// @body:organ=muscle type=strategy role="roundrobin: rotate the head across requests"
let turn = 0;

export default {
  name: 'roundrobin',
  order(ctx) {
    const ids = ctx.models.map((m) => m.id);
    if (ids.length === 0) return [];
    const k = turn++ % ids.length;
    return [...ids.slice(k), ...ids.slice(0, k)];
  },
};
