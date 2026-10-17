// @body:organ=muscle type=probe role="revive unhealthy models + keep standby models pre-warmed + periodic full-model sweep"
import { byId } from './providers/index.mjs';
import { getChatModels, demote } from './catalog.mjs';
import { isUnhealthy, revive, healthyCandidates, getRoutesState, recordProbe, getLastRequestAt } from './routes.mjs';
import { assembleChatCompletion } from './util/sse.mjs';
import { bus } from './util/events.mjs';
import { logger } from './util/log.mjs';

const probeState = new Map(); // id -> {lastOk, lastErr, lastWarmAt, okCount, failCount}
const sweepState = { lastSweepAt: 0, lastSweepMs: 0, tested: 0, alive: 0, dead: 0 };
let loop = null;
let sweepLoop = null;

function entry(id) {
  let e = probeState.get(id);
  if (!e) { e = { lastOk: 0, lastErr: null, lastWarmAt: 0, okCount: 0, failCount: 0 }; probeState.set(id, e); }
  return e;
}

export function getProbeState() {
  return Object.fromEntries([...probeState].map(([id, e]) => [id, { ...e }]));
}

export function getSweepState() {
  return { ...sweepState };
}

async function ping(cfg, model) {
  const provider = byId[model.provider];
  if (!provider) return { ok: false, kind: 'noprovider' };
  const cred = provider.listCredentials(cfg)[0];
  if (!cred) return { ok: false, kind: 'nocred' };
  try {
    const res = await provider.chat(
      cfg,
      cred,
      { model: model.id, messages: [{ role: 'user', content: 'ping' }] },
      { signal: AbortSignal.timeout(cfg.selection.attemptTimeoutMs) },
    );
    const text = await res.text();
    if (res.ok) {
      // Drain the SSE so the upstream connection is fully consumed.
      assembleChatCompletion(text, { stripToolNames: new Set(provider.gateTools ?? []) });
      return { ok: true };
    }
    return { ok: false, kind: provider.classifyError(res.status, text), status: res.status };
  } catch (err) {
    return { ok: false, kind: 'transient', error: err?.message ?? String(err) };
  }
}

// Sweep ping: shorter timeout (15s) so a full catalog sweep stays bounded.
async function sweepPing(cfg, model) {
  const provider = byId[model.provider];
  if (!provider) return { ok: false, kind: 'noprovider' };
  const cred = provider.listCredentials(cfg)[0];
  if (!cred) return { ok: false, kind: 'nocred' };
  try {
    const res = await provider.chat(
      cfg,
      cred,
      { model: model.id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 4 },
      { signal: AbortSignal.timeout(15_000) },
    );
    const text = await res.text();
    if (res.ok) {
      assembleChatCompletion(text, { stripToolNames: new Set(provider.gateTools ?? []) });
      return { ok: true };
    }
    return { ok: false, kind: provider.classifyError(res.status, text), status: res.status };
  } catch (err) {
    return { ok: false, kind: 'transient', error: err?.message ?? String(err) };
  }
}

// Full-model sweep: ping every chat model with a tiny prompt. Failures that
// indicate a dead/paid/blocked model (auth, billing, notfound, deprecated)
// are demoted immediately so they disappear from the pool. Transient /
// ratelimit failures just cool the model (existing cooldown logic).
// Concurrency is bounded so the sweep never hammers upstreams or blocks the
// request path.
async function sweepModels(cfg) {
  const now = Date.now();
  const models = getChatModels();
  sweepState.lastSweepAt = now;
  sweepState.tested = 0;
  sweepState.alive = 0;
  sweepState.dead = 0;
  if (models.length === 0) { sweepState.lastSweepMs = 0; return sweepState; }

  const t0 = Date.now();
  const CONCURRENCY = 4;
  for (let i = 0; i < models.length; i += CONCURRENCY) {
    const batch = models.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((m) => sweepPing(cfg, m)));
    for (const [model, out] of batch.map((m, j) => [m, results[j]])) {
      sweepState.tested += 1;
      if (out.ok) {
        sweepState.alive += 1;
        const e = entry(model.id);
        e.lastOk = now;
        e.lastErr = null;
        e.okCount += 1;
        if (isUnhealthy(model.id)) {
          revive(model.id);
          logger.info('sweep revived model', { model: model.id });
          bus.emit('probe', { model: model.id, ok: true, kind: 'sweep-revive' });
        }
      } else {
        sweepState.dead += 1;
        const e = entry(model.id);
        e.failCount += 1;
        e.lastErr = { kind: out.kind, status: out.status, at: now };
        if (out.kind === 'billing') { demote(model.id, 'billing-signal-sweep'); }
        else if (out.kind === 'deprecated') { demote(model.id, 'deprecated-upstream-sweep'); }
        else if (out.kind === 'notfound') { demote(model.id, 'notfound-sweep'); }
        else if (out.kind === 'auth') { demote(model.id, 'auth-sweep'); }
        if (out.kind === 'freetier' && typeof byId[model.provider]?.rotateSession === 'function') {
          byId[model.provider].rotateSession();
        }
        bus.emit('probe', { model: model.id, ok: false, kind: out.kind, action: 'sweep' });
        logger.warn('sweep demoted model', { model: model.id, kind: out.kind, status: out.status });
      }
    }
    // Small breath between batches so we don't slam upstreams.
    if (i + CONCURRENCY < models.length) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  sweepState.lastSweepMs = Date.now() - t0;
  logger.info('sweep complete', { tested: sweepState.tested, alive: sweepState.alive, dead: sweepState.dead, ms: sweepState.lastSweepMs });
  return sweepState;
}

// One probe cycle: revive targets first, then prewarm the least-recently
// warmed healthy standbys. Best-effort — probe failures never touch routes.
export async function runOnce(cfg) {
  const reviveTargets = getChatModels().filter((m) => isUnhealthy(m.id));
  const warmed = new Set(reviveTargets.map((m) => m.id));
  const standbyCount = cfg.probe?.standbyWarm ?? 0;
  const standbys = healthyCandidates()
    .filter((m) => !warmed.has(m.id))
    .sort((a, b) => entry(a.id).lastWarmAt - entry(b.id).lastWarmAt)
    .slice(0, standbyCount);

  const jobs = [
    ...reviveTargets.map((m) => ({ model: m, kind: 'revive' })),
    ...standbys.map((m) => ({ model: m, kind: 'warm' })),
  ];
  if (jobs.length === 0 && !shouldSweep(cfg)) return { probed: 0, revived: 0 };

  let revived = 0;
  for (const job of jobs) {
    const e = entry(job.model.id);
    const out = await ping(cfg, job.model);
    recordProbe(job.model.id);
    if (out.ok) {
      e.lastOk = Date.now();
      e.lastWarmAt = Date.now();
      e.okCount += 1;
      e.lastErr = null;
      if (job.kind === 'revive') {
        revive(job.model.id);
        revived += 1;
        logger.info('probe revived model', { model: job.model.id });
        bus.emit('probe', { model: job.model.id, ok: true, kind: job.kind });
      }
    } else {
      e.failCount += 1;
      e.lastErr = { kind: out.kind, status: out.status, at: Date.now() };
      if (out.kind === 'billing') demote(job.model.id, 'billing-signal-probe');
      if (out.kind === 'deprecated') demote(job.model.id, 'deprecated-upstream-probe');
      if (out.kind === 'freetier' && typeof byId[job.model.provider]?.rotateSession === 'function') {
        byId[job.model.provider].rotateSession();
      }
      bus.emit('probe', { model: job.model.id, ok: false, kind: out.kind, action: job.kind });
      logger.warn('probe failed', { model: job.model.id, kind: out.kind, action: job.kind });
    }
  }

  if (shouldSweep(cfg)) {
    await sweepModels(cfg);
  }

  return { probed: jobs.length, revived };
}

function shouldSweep(cfg) {
  const sweepInterval = cfg.probe?.sweepIntervalMs ?? 0;
  if (!sweepInterval || sweepInterval <= 0) return false;
  const now = Date.now();
  if (now - (sweepState.lastSweepAt || 0) < sweepInterval) return false;
  // Only sweep when the router has seen recent use — don't burn upstream
  // quota on an idle instance.
  const activeWindow = cfg.probe?.sweepActiveWindowMs ?? sweepInterval;
  if (now - getLastRequestAt() > activeWindow) return false;
  return true;
}

export function startProbe(cfg) {
  stopProbe();
  loop = setInterval(() => {
    runOnce(cfg).catch((err) => logger.error('probe cycle error', { error: err.message }));
  }, cfg.probe.intervalMs);
  if (typeof loop.unref === 'function') loop.unref();

  // Separate ticker for the sweep so it keeps its own cadence even when the
  // probe interval is short.
  if (sweepLoop) clearInterval(sweepLoop);
  sweepLoop = setInterval(() => {
    if (shouldSweep(cfg)) {
      void sweepModels(cfg).catch((err) => logger.error('sweep error', { error: err.message }));
    }
  }, Math.min(cfg.probe?.intervalMs ?? 120_000, 60_000));
  if (typeof sweepLoop.unref === 'function') sweepLoop.unref();
}

export function stopProbe() {
  if (loop) clearInterval(loop);
  loop = null;
  if (sweepLoop) clearInterval(sweepLoop);
  sweepLoop = null;
}

// Debug helper for tests/dashboard: current unhealthy set from the engine.
export function unhealthyModels() {
  return getRoutesState().models.filter((m) => m.unhealthyUntil > Date.now()).map((m) => m.id);
}
