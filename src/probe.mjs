// @body:organ=muscle type=probe role="revive unhealthy models + keep standby models pre-warmed + periodic full-model sweep"
import { byId } from './providers/index.mjs';
import { getChatModels, getModel, demote } from './catalog.mjs';
import { isUnhealthy, revive, healthyCandidates, getRoutesState, recordProbe, getLastRequestAt, recordOutcome } from './routes.mjs';
import { assembleChatCompletion } from './util/sse.mjs';
import { takePing } from './freeLanes.mjs';
import { store } from './store.mjs';
import { PROBE_STATE_PATH, serializeProbeState, parseProbeState } from './probeStore.mjs';
import { bus } from './util/events.mjs';
import { logger } from './util/log.mjs';

const probeState = new Map(); // id -> {lastOk, lastErr, lastWarmAt, okCount, failCount}
const sweepState = { lastSweepAt: 0, lastSweepMs: 0, tested: 0, alive: 0, dead: 0 };
let loop = null;
let sweepLoop = null;

// Results survive restarts (and recycled Worker isolates) through the store seam.
// Restored lazily on first use; anything already measured in this process wins.
let restored = false;
let dirty = false;
let lastFlushAt = 0;
const FLUSH_MIN_MS = 10_000;

export function restoreProbeState(text, now = Date.now()) {
  restored = true;
  for (const [id, e] of parseProbeState(text, now)) if (!probeState.has(id)) probeState.set(id, e);
}

function ensureRestored() {
  if (restored) return;
  try { restoreProbeState(store.read(PROBE_STATE_PATH)); } catch { restored = true; }
}

// Throttled by time rather than by timers: Workers can freeze an isolate right
// after a response, so callers that matter (worker settle loop, cron, shutdown)
// pass { force: true }.
export function flushProbeState({ force = false, now = Date.now() } = {}) {
  if (!dirty || (!force && now - lastFlushAt < FLUSH_MIN_MS)) return false;
  dirty = false;
  lastFlushAt = now;
  try { store.write(PROBE_STATE_PATH, serializeProbeState(probeState, now)); } catch (err) { logger.warn('probe state save failed', { error: err.message }); }
  return true;
}

function entry(id) {
  ensureRestored();
  let e = probeState.get(id);
  if (!e) { e = { lastOk: 0, lastErr: null, lastWarmAt: 0, okCount: 0, failCount: 0, lastMs: null, lastLimited: 0, checkedAt: 0 }; probeState.set(id, e); }
  return e;
}

export function getProbeState() {
  ensureRestored();
  return Object.fromEntries([...probeState].map(([id, e]) => [id, { ...e }]));
}

export function getSweepState() {
  return { ...sweepState };
}

// One tiny authenticated chat call. max_tokens 16 (not 4): some upstreams 400 on
// tiny limits, and a 400 here used to mark a healthy model as dead.
async function pingModel(cfg, model, { timeoutMs, maxTokens = 16, prompt = 'hi' } = {}) {
  const provider = byId[model.provider];
  if (!provider) return { ok: false, kind: 'noprovider' };
  const cred = provider.listCredentials(cfg)[0];
  if (!cred) return { ok: false, kind: 'nocred' };
  const started = Date.now();
  try {
    const res = await provider.chat(
      cfg,
      cred,
      { model: model.id, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens },
      { signal: AbortSignal.timeout(timeoutMs ?? cfg.selection.attemptTimeoutMs) },
    );
    const text = await res.text();
    if (res.ok) {
      // Drain the SSE so the upstream connection is fully consumed.
      assembleChatCompletion(text, { stripToolNames: new Set(provider.gateTools ?? []) });
      return { ok: true, ms: Date.now() - started, lane: cred.source ?? 'key' };
    }
    return { ok: false, kind: provider.classifyError(res.status, text), status: res.status, ms: Date.now() - started, lane: cred.source ?? 'key' };
  } catch (err) {
    return { ok: false, kind: 'transient', error: err?.message ?? String(err), ms: Date.now() - started, lane: cred.source ?? 'key' };
  }
}

const ping = (cfg, model) => pingModel(cfg, model);
const sweepPing = (cfg, model) => pingModel(cfg, model, { timeoutMs: 15_000 });

const SOFT_DEMOTE_MS = 6 * 3_600_000;

// What a failed ping is allowed to do to the pool:
//  billing   → out until a manual reinstate (free-guard, never lets a paid model through)
//  deprecated/404 → out for 6h, then re-listed and re-checked
//  401/403 on a KEYLESS lane → that model needs a paid token: out for 6h
//  400/401/403 on your own key, 429, 5xx, timeouts → only mark the model. A
//  rotated key or a picky request body must not wipe a provider out of the pool.
function applyPingVerdict(model, out, suffix) {
  if (out.kind === 'billing') demote(model.id, `billing-signal-${suffix}`);
  else if (out.kind === 'deprecated') demote(model.id, `deprecated-upstream-${suffix}`, { ttlMs: SOFT_DEMOTE_MS });
  else if (out.kind === 'notfound' && out.status === 404) demote(model.id, `notfound-${suffix}`, { ttlMs: SOFT_DEMOTE_MS });
  else if (out.kind === 'auth' && out.lane === 'anonymous') demote(model.id, `needs-token-${suffix}`, { ttlMs: SOFT_DEMOTE_MS });
  if (out.kind === 'freetier' && typeof byId[model.provider]?.rotateSession === 'function') byId[model.provider].rotateSession();
}

// A 429 says "slow down", not "broken" — routine on free tiers. It is kept
// apart from failures so a busy model never shows up as failing.
function recordPingResult(model, out, now = Date.now()) {
  const e = entry(model.id);
  e.checkedAt = now;
  dirty = true;
  flushProbeState({ now });
  if (!out.ok && out.kind === 'ratelimit') {
    e.lastLimited = now;
    return e;
  }
  e.lastMs = out.ms ?? null;
  recordOutcome(model.id, out.ok);
  if (out.ok) {
    e.lastOk = now;
    e.lastWarmAt = now;
    e.okCount += 1;
    e.lastErr = null;
    return e;
  }
  e.failCount += 1;
  e.lastErr = { kind: out.kind, status: out.status, at: now };
  return e;
}

// On-demand verification used by the dashboard "test" buttons: bounded batch,
// same verdict rules as the sweep, results returned so the UI can show them.
export async function verifyModels(cfg, ids, { concurrency = 4, max = 12 } = {}) {
  const models = [...new Set(ids)].slice(0, max).map((id) => getModel(id)).filter((m) => m && m.protocol === 'chat');
  for (const m of models) takePing(m.provider, { force: true });
  const results = [];
  for (let i = 0; i < models.length; i += concurrency) {
    const batch = models.slice(i, i + concurrency);
    const outs = await Promise.all(batch.map((m) => pingModel(cfg, m, { timeoutMs: 20_000 })));
    batch.forEach((model, j) => {
      const out = outs[j];
      recordPingResult(model, out);
      if (out.ok && isUnhealthy(model.id)) revive(model.id);
      if (!out.ok) applyPingVerdict(model, out, 'verify');
      bus.emit('probe', { model: model.id, ok: out.ok, kind: out.ok ? 'verify' : out.kind, action: 'verify' });
      results.push({ id: model.id, provider: model.provider, ok: out.ok, limited: !out.ok && out.kind === 'ratelimit', kind: out.kind ?? null, status: out.status ?? null, ms: out.ms ?? null });
    });
  }
  flushProbeState({ force: true });
  return results;
}

// Full-model sweep: ping every chat model with a tiny prompt. Failures that
// indicate a dead/paid/blocked model (auth, billing, notfound, deprecated)
// are demoted immediately so they disappear from the pool. Transient /
// ratelimit failures just cool the model (existing cooldown logic).
// Concurrency is bounded so the sweep never hammers upstreams or blocks the
// request path.
async function sweepModels(cfg) {
  const now = Date.now();
  // Stalest first: when a provider's hourly ceiling cuts the sweep short, the
  // next sweep picks up the models that were skipped.
  const models = getChatModels().sort((a, b) => entry(a.id).checkedAt - entry(b.id).checkedAt);
  sweepState.lastSweepAt = now;
  sweepState.tested = 0;
  sweepState.alive = 0;
  sweepState.dead = 0;
  if (models.length === 0) { sweepState.lastSweepMs = 0; return sweepState; }

  const t0 = Date.now();
  const CONCURRENCY = 4;
  for (let i = 0; i < models.length; i += CONCURRENCY) {
    const batch = models.slice(i, i + CONCURRENCY).filter((m) => takePing(m.provider));
    if (batch.length === 0) continue;
    const results = await Promise.all(batch.map((m) => sweepPing(cfg, m)));
    for (const [model, out] of batch.map((m, j) => [m, results[j]])) {
      sweepState.tested += 1;
      recordPingResult(model, out, now);
      if (out.ok) {
        sweepState.alive += 1;
        if (isUnhealthy(model.id)) {
          revive(model.id);
          logger.info('sweep revived model', { model: model.id });
          bus.emit('probe', { model: model.id, ok: true, kind: 'sweep-revive' });
        }
      } else {
        sweepState.dead += 1;
        applyPingVerdict(model, out, 'sweep');
        bus.emit('probe', { model: model.id, ok: false, kind: out.kind, action: 'sweep' });
        logger.warn('sweep: model failed ping', { model: model.id, kind: out.kind, status: out.status });
      }
    }
    // Small breath between batches so we don't slam upstreams.
    if (i + CONCURRENCY < models.length) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  sweepState.lastSweepMs = Date.now() - t0;
  logger.info('sweep complete', { tested: sweepState.tested, alive: sweepState.alive, dead: sweepState.dead, ms: sweepState.lastSweepMs });
  flushProbeState({ force: true });
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
    if (!takePing(job.model.provider)) continue;
    const out = await ping(cfg, job.model);
    recordProbe(job.model.id);
    recordPingResult(job.model, out);
    if (out.ok) {
      if (job.kind === 'revive') {
        revive(job.model.id);
        revived += 1;
        logger.info('probe revived model', { model: job.model.id });
        bus.emit('probe', { model: job.model.id, ok: true, kind: job.kind });
      }
    } else {
      applyPingVerdict(job.model, out, 'probe');
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
  flushProbeState({ force: true });
  if (loop) clearInterval(loop);
  loop = null;
  if (sweepLoop) clearInterval(sweepLoop);
  sweepLoop = null;
}

// Debug helper for tests/dashboard: current unhealthy set from the engine.
export function unhealthyModels() {
  return getRoutesState().models.filter((m) => m.unhealthyUntil > Date.now()).map((m) => m.id);
}
