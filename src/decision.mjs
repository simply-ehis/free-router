// @body:organ=muscle type=decision role="jev systemone client (keyless) + classify/diagnose/rank features — fail-open, time-boxed, self-disabling"
import { logger } from './util/log.mjs';

const DEFAULT_URL = 'https://opencode.ai/zen/v1/systemone';
const HARD_FAIL_LIMIT = 3;
const DISABLED_MS = 300_000;
const LOG_CAP = 100;
const DEFAULT_TIMEOUT_MS = 700;

const runtime = { consecutiveFails: 0, disabledUntil: 0 };
const log = [];

function baseUrl(cfg) {
  const b = cfg?.decision?.baseUrl;
  return typeof b === 'string' && b.trim() ? b.trim() : DEFAULT_URL;
}

function enabled(cfg) {
  return cfg?.decision?.enabled === true;
}

function pushLog(entry) {
  log.push(entry);
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
}

function summarize(answers) {
  const out = {};
  for (const [name, a] of Object.entries(answers ?? {})) {
    out[name] = a?.type === 'score' ? a.score : a?.type === 'choice' ? a.choice : a?.noul;
  }
  return out;
}

// Core client. NEVER sends an Authorization header: the -free model id is the
// gate, and adding auth risks workspace routing onto the paid id.
// Returns {model, answers, usage} or null (fail-open). After HARD_FAIL_LIMIT
// consecutive hard failures the plane disables itself for DISABLED_MS.
export async function decide(cfg, state, questions, { purpose = 'general', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!enabled(cfg)) return null;
  const now = Date.now();
  if (now < runtime.disabledUntil) return null;
  try {
    const res = await fetch(baseUrl(cfg), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.decision.model, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`jev ${res.status}: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text);
    runtime.consecutiveFails = 0;
    pushLog({ at: now, purpose, ms: Date.now() - now, ok: true, summary: summarize(parsed.answers) });
    return parsed;
  } catch (err) {
    runtime.consecutiveFails += 1;
    pushLog({ at: now, purpose, ms: Date.now() - now, ok: false, summary: err.message });
    if (runtime.consecutiveFails >= HARD_FAIL_LIMIT) {
      runtime.disabledUntil = Date.now() + DISABLED_MS;
      logger.warn('decision plane self-disabled', { disabledForMs: DISABLED_MS, lastError: err.message });
    }
    logger.debug('decision call failed (fail-open)', { purpose, error: err.message });
    return null;
  }
}

// Request classification for the smartest strategy: complexity 0..3.
export async function classifyRequest(cfg, messages) {
  if (!enabled(cfg) || cfg.decision.classify !== true) return null;
  const state = {
    messages: (Array.isArray(messages) ? messages : []).slice(-8).map((m) => ({
      role: m?.role ?? 'user',
      content: typeof m?.content === 'string' ? m.content.slice(0, 2000) : '[non-text]',
    })),
  };
  const out = await decide(cfg, state, {
    complexity: {
      type: 'score',
      instructions: 'How complex is this coding/agent request?',
      criteria: ['Trivial one-liner', 'Simple routine task', 'Moderate multi-step work', 'Hard expert-level task'],
    },
  }, { purpose: 'classify' });
  const a = out?.answers?.complexity;
  if (a?.type !== 'score') return null;
  return { complexity: a.score, confidence: a.confidence ?? null };
}

const FAILURE_CRITERIA = {
  ratelimit: 'Too many requests or quota exhausted',
  model_dead: 'Model removed or endpoint gone',
  billing: 'Insufficient balance or payment issue',
  transient: 'Temporary network or server error',
};
const FAILURE_KIND_MAP = { ratelimit: 'ratelimit', model_dead: 'notfound', billing: 'billing', transient: 'transient' };

// Failure-cause classification for the engine: maps a raw unknown failure to a
// known backoff kind, or null when the plane cannot say.
export async function diagnoseFailure(cfg, detail) {
  if (!enabled(cfg) || cfg.decision.diagnose !== true) return null;
  const state = {
    status: detail?.status ?? 0,
    upstreamKind: detail?.kind ?? 'unknown',
    model: detail?.model ?? '',
    detail: typeof detail?.text === 'string' ? detail.text.slice(0, 500) : '',
  };
  const out = await decide(cfg, state, {
    cause: { type: 'choice', instructions: 'What caused this upstream failure?', criteria: FAILURE_CRITERIA },
  }, { purpose: 'diagnose' });
  const a = out?.answers?.cause;
  if (a?.type !== 'choice') return null;
  return FAILURE_KIND_MAP[a.choice] ?? null;
}

// Sampled ranking hints over route telemetry — logged for the dashboard /
// smartest feedback loop, never blocking.
export async function maybeRankHints(cfg, snapshot) {
  if (!enabled(cfg) || cfg.decision.rankHints !== true) return null;
  if (Math.random() >= 0.1) return null;
  const candidates = (Array.isArray(snapshot?.candidates) ? snapshot.candidates : []).slice(0, 8);
  if (candidates.length < 2) return null;
  const criteria = Object.fromEntries(
    candidates.map((c) => [c.id, `success ${c.successRate ?? '?'} avg latency ${c.latencyMs ?? '?'}ms`]),
  );
  const out = await decide(cfg, { requested: snapshot?.requested ?? '' }, {
    preferred: { type: 'choice', instructions: 'Which route should be preferred for future requests?', criteria },
  }, { purpose: 'rank-hints' });
  const a = out?.answers?.preferred;
  if (a?.type === 'choice') logger.info('rank hint', { requested: snapshot?.requested, preferred: a.choice, confidence: a.confidence });
  return a?.type === 'choice' ? a.choice : null;
}

export function getDecisionState(cfg) {
  return {
    enabled: enabled(cfg),
    model: cfg?.decision?.model ?? null,
    consecutiveFails: runtime.consecutiveFails,
    disabledUntil: runtime.disabledUntil,
    recent: [...log],
  };
}

export function resetDecisionState() {
  runtime.consecutiveFails = 0;
  runtime.disabledUntil = 0;
  log.length = 0;
}
