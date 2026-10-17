// @body:organ=brain type=engine role="classify request → strategy order → attempt/failover loop (stream + non-stream) → telemetry + sticky"
import { getChatModels, getModel, demote } from './catalog.mjs';
import { withPersona } from './persona.mjs';
import { contextWindowOf, estimateTokens, truncateOldest, splitForSummarize } from './context.mjs';
import { byId } from './providers/index.mjs';
import { select } from './strategies/index.mjs';
import { classifyRequest as askClassification, diagnoseFailure, maybeRankHints } from './decision.mjs';
import { checkToolCalls } from './middleware/toolverify.mjs';
import { bus } from './util/events.mjs';
import { logger } from './util/log.mjs';
import { assembleChatCompletion, looksLikeSSE } from './util/sse.mjs';
import { record as recordUsage } from './usage.mjs';

const MAX_ATTEMPTS = 3;
const THROTTLE_BASE_MS = 5_000;
const THROTTLE_CAP_MS = 300_000;
const UNHEALTHY_FAILS = 3;
const UNHEALTHY_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 600_000;

const state = {
  models: new Map(), // id -> {latencyMs, ok, fail, consecutiveFails, throttleLevel, throttledUntil, unhealthyUntil, lastUsedAt}
  creds: new Map(),  // "provider:label" -> {disabledUntil}
  sticky: new Map(), // requestedModel -> {modelId, label, at}
  rr: 0,
  lastRequestAt: 0,
};

function modelState(id) {
  let e = state.models.get(id);
  if (!e) {
    e = { latencyMs: null, ok: 0, fail: 0, consecutiveFails: 0, throttleLevel: 0, throttledUntil: 0, unhealthyUntil: 0, lastUsedAt: 0, lastProbeAt: 0 };
    state.models.set(id, e);
  }
  return e;
}

function credState(provider, label) {
  const key = `${provider}:${label}`;
  let e = state.creds.get(key);
  if (!e) { e = { disabledUntil: 0 }; state.creds.set(key, e); }
  return e;
}

function usable(entry, now = Date.now()) {
  return now >= entry.throttledUntil && now >= entry.unhealthyUntil;
}

export function healthyCandidates() {
  const now = Date.now();
  return getChatModels().filter((m) => usable(modelState(m.id), now));
}

export function isUnhealthy(modelId, now = Date.now()) {
  const e = state.models.get(modelId);
  return e ? now < e.unhealthyUntil : false;
}

export function recordProbe(modelId, at = Date.now()) {
  modelState(modelId).lastProbeAt = at;
}

export function revive(modelId) {
  const e = state.models.get(modelId);
  if (!e) return;
  e.consecutiveFails = 0;
  e.unhealthyUntil = 0;
  e.throttledUntil = 0;
  e.throttleLevel = 0;
}

export function getRoutesState() {
  return {
    models: [...state.models].map(([id, s]) => ({ id, ...s })),
    sticky: Object.fromEntries(state.sticky),
    creds: [...state.creds].map(([key, s]) => ({ key, ...s })),
  };
}

export function resetState() {
  state.models.clear();
  state.creds.clear();
  state.sticky.clear();
  state.rr = 0;
  state.lastRequestAt = 0;
}

export function getLastRequestAt() {
  return state.lastRequestAt;
}

function classifyRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  return {
    valid: messages !== null,
    needsTools: Array.isArray(body?.tools) && body.tools.length > 0,
    stream: body?.stream === true,
  };
}

function httpErr(status, message, code, attempts = []) {
  return {
    status,
    text: JSON.stringify({ error: { message, type: status >= 500 ? 'router_error' : 'invalid_request_error', code } }),
    attempts,
    route: null,
  };
}

// Client-facing name → real route target. Aliases win first ("fast" → a real
// model id); an id the catalog does not know (typo, paid model, dead alias
// target) falls back to selection.defaultModel so clients get a deliberate
// best-effort route instead of pure strategy order.
export function resolveRequested(cfg, requested) {
  const aliases = cfg?.selection?.aliases ?? {};
  const aliasTarget = typeof aliases[requested] === 'string' ? aliases[requested].trim() : '';
  const resolved = aliasTarget || requested;
  if (getModel(resolved)) return { id: resolved, via: aliasTarget ? 'alias' : 'exact' };
  const def = typeof cfg?.selection?.defaultModel === 'string' ? cfg.selection.defaultModel.trim() : '';
  if (def) return { id: def, via: 'default' };
  return { id: resolved, via: 'exact' };
}

function pickCred(cfg, provider, preferredLabel) {
  const creds = provider.listCredentials(cfg).filter((c) => Date.now() >= credState(provider.id, c.label).disabledUntil);
  if (creds.length === 0) return null;
  if (preferredLabel) {
    const preferred = creds.find((c) => c.label === preferredLabel);
    if (preferred) return preferred;
  }
  return creds[state.rr++ % creds.length];
}

function throttle(entry) {
  entry.throttleLevel += 1;
  const ms = Math.min(THROTTLE_BASE_MS * 2 ** (entry.throttleLevel - 1), THROTTLE_CAP_MS);
  entry.throttledUntil = Date.now() + ms;
}

function recordFailure(entry, cred, provider, kind) {
  entry.fail += 1;
  entry.consecutiveFails += 1;
  if (kind === 'ratelimit') throttle(entry);
  if ((kind === 'transient' || kind === 'notfound' || kind === 'freetier') && entry.consecutiveFails >= UNHEALTHY_FAILS) {
    entry.unhealthyUntil = Date.now() + UNHEALTHY_COOLDOWN_MS;
  }
  if (kind === 'auth') credState(provider, cred.label).disabledUntil = Date.now() + AUTH_COOLDOWN_MS;
}

// Single place every failure kind is applied: health, demotion, session rotation.
// Unknown failures additionally get a fire-and-forget Jev diagnosis that may
// retroactively demote the model — the hot path never waits on the decision plane.
function applyFailure(cfg, provider, model, entry, cred, kind, detail) {
  recordFailure(entry, cred, model.provider, kind);
  if (kind === 'billing') demote(model.id, 'billing-signal');
  if (kind === 'deprecated') demote(model.id, 'deprecated-upstream');
  if (kind === 'freetier' && typeof provider.rotateSession === 'function') provider.rotateSession();
  if (kind === 'unknown' && cfg?.decision?.enabled === true && cfg.decision.diagnose === true) {
    void diagnoseFailure(cfg, detail).then((refined) => {
      if (refined === 'billing') { demote(model.id, 'billing-signal-diagnosed'); logger.warn('diagnosed billing failure', { model: model.id }); }
      if (refined === 'notfound') { demote(model.id, 'deprecated-upstream-diagnosed'); logger.warn('diagnosed dead model', { model: model.id }); }
    });
  }
}

function recordSuccess(entry, ms) {
  entry.ok += 1;
  entry.consecutiveFails = 0;
  entry.throttleLevel = 0;
  entry.latencyMs = entry.latencyMs == null ? ms : Math.round(entry.latencyMs * 0.7 + ms * 0.3);
  entry.lastUsedAt = Date.now();
}

// Upstream-reported token counts (best-effort — streams rarely report usage).
function tokensOf(text) {
  try {
    const usage = JSON.parse(text)?.usage;
    return { tokensIn: Number(usage?.prompt_tokens) || 0, tokensOut: Number(usage?.completion_tokens) || 0 };
  } catch {
    return { tokensIn: 0, tokensOut: 0 };
  }
}

// Gate tools the adapter had to inject for THIS request (present upstream,
// absent from the client) — their tool_calls must never reach the client.
function injectedGateTools(provider, body) {
  const clientNames = new Set((Array.isArray(body?.tools) ? body.tools : []).map((t) => t?.function?.name));
  return new Set((provider.gateTools ?? []).filter((n) => !clientNames.has(n)));
}

// Tool-verify gate: non-stream only (streaming relays bytes unbuffered by
// design). Requests without tools skip the plane entirely; plane outage fails open.
async function verifyResponse(cfg, body, text) {
  if (cfg?.decision?.toolVerify === 'off') return { action: 'allow' };
  if (cfg?.decision?.toolVerify === 'off') return { action: 'allow' };
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return { action: 'allow' };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { action: 'allow' }; }
  return checkToolCalls(cfg, body, parsed);
}

// Flagged responses ride through with a non-standard marker field; OpenAI-
// compatible clients ignore unknown top-level fields.
function markFlagged(text, prob) {
  try {
    const obj = JSON.parse(text);
    obj.x_router = { tool_verify: 'flagged', justified: prob };
    return JSON.stringify(obj);
  } catch {
    return text;
  }
}

const SUMMARIZE_SYSTEM =
  'Summarize the following conversation excerpt into a compact context brief: preserve user goals, '
  + 'constraints, key decisions, and pending tasks. Output only the summary, no preamble.';

// Fail-open to truncate on any summarize error/timeout/bad payload.
async function summarizeDropped(cfg, model, cred, messages, window) {
  const provider = byId[model.provider];
  const { system, keep, dropped } = splitForSummarize(messages, window);
  if (dropped.length === 0) return null;
  const timeoutMs = Number.isInteger(cfg?.compaction?.summarizeTimeoutMs) ? cfg.compaction.summarizeTimeoutMs : 15000;
  try {
    const res = await provider.chat(cfg, cred, {
      model: model.id,
      stream: false,
      max_tokens: 400,
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: JSON.stringify(dropped) },
      ],
    }, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const text = await res.text();
    let summary;
    try { summary = JSON.parse(text)?.choices?.[0]?.message?.content; } catch { return null; }
    if (typeof summary !== 'string' || !summary.trim()) return null;
    return {
      messages: [...system, { role: 'system', content: `Conversation summary so far:\n${summary.trim()}` }, ...keep],
      mode: 'summarize',
      dropped: dropped.length,
    };
  } catch {
    return null;
  }
}

// Per-attempt compaction: different candidates may have different windows.
async function compactForAttempt(cfg, model, cred, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages) return { body, compaction: null };
  const window = contextWindowOf(cfg, model.id);
  const est = estimateTokens(messages);
  if (est <= window) return { body, compaction: null };
  let result = null;
  if ((cfg?.compaction?.strategy ?? 'summarize') === 'summarize') {
    result = await summarizeDropped(cfg, model, cred, messages, window);
  }
  if (!result) {
    const t = truncateOldest(messages, window);
    if (t.dropped === 0) return { body, compaction: null };
    result = { messages: t.messages, mode: 'truncate', dropped: t.dropped };
  }
  bus.emit('compaction', { model: model.id, mode: result.mode, dropped: result.dropped, est, window });
  logger.info('messages compacted', { model: model.id, mode: result.mode, dropped: result.dropped, est, window });
  return { body: { ...body, messages: result.messages }, compaction: result };
}

function markCompacted(text, compaction) {
  if (!compaction) return text;
  try {
    const obj = JSON.parse(text);
    obj.x_router = { ...(obj.x_router ?? {}), compacted: true, mode: compaction.mode, dropped: compaction.dropped };
    return JSON.stringify(obj);
  } catch {
    return text;
  }
}

async function attemptNonStream(cfg, model, cred, body) {
  const provider = byId[model.provider];
  const t0 = Date.now();
  try {
    const res = await provider.chat(cfg, cred, { ...body, model: model.id }, {
      signal: AbortSignal.timeout(cfg.selection.attemptTimeoutMs),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (res.ok) {
      if (looksLikeSSE(res.headers.get('content-type'), text)) {
        const assembled = assembleChatCompletion(text, { stripToolNames: injectedGateTools(provider, body) });
        return { ok: true, status: res.status, text: JSON.stringify(assembled), ms };
      }
      return { ok: true, status: res.status, text, ms };
    }
    return { ok: false, kind: provider.classifyError(res.status, text), status: res.status, text, ms };
  } catch (err) {
    return {
      ok: false,
      kind: 'transient',
      status: 0,
      ms: Date.now() - t0,
      error: err?.name === 'TimeoutError' ? 'timeout' : err?.message ?? String(err),
    };
  }
}

// Stream attempts: time-box applies to HEADERS only — the body must be able
// to run indefinitely after the relay starts.
async function attemptStream(cfg, model, cred, body) {
  const provider = byId[model.provider];
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.selection.attemptTimeoutMs);
  try {
    const res = await provider.chat(cfg, cred, { ...body, model: model.id }, { signal: ctrl.signal });
    if (res.ok) {
      clearTimeout(timer);
      return { ok: true, res, ms: Date.now() - t0 };
    }
    const text = await res.text();
    clearTimeout(timer);
    return { ok: false, kind: provider.classifyError(res.status, text), status: res.status, text, ms: Date.now() - t0 };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      kind: 'transient',
      status: 0,
      ms: Date.now() - t0,
      error: err?.name === 'AbortError' ? 'timeout' : err?.message ?? String(err),
    };
  }
}

async function orderCandidates(cfg, body, target, pool, previous) {
  const ctx = {
    models: pool,
    cfg,
    needsTools: Array.isArray(body?.tools) && body.tools.length > 0,
    previous,
    states: new Map(pool.map((m) => [m.id, modelState(m.id)])),
    sources: new Map(pool.map((m) => [m.id, m.sources])),
  };
  if (cfg.decision?.enabled === true && cfg.decision.classify === true && Array.isArray(body?.messages)) {
    // Prefilled promise: internally time-boxed, strategy races it under its own
    // timebox — a slow plane degrades to default ranking, never stalls.
    ctx.decisionHints = askClassification(cfg, body.messages);
  }
  let orderedIds = await select(cfg, ctx);
  const explicit = getModel(target.id);
  if (explicit && explicit.protocol === 'chat' && pool.some((m) => m.id === target.id)) {
    orderedIds = [target.id, ...orderedIds.filter((id) => id !== target.id)];
  }
  return orderedIds;
}

async function runNonStream(cfg, body, orderedIds, requested, previous, meta) {
  const attempts = [];
  for (const modelId of orderedIds.slice(0, MAX_ATTEMPTS)) {
    const model = getModel(modelId);
    if (!model) continue;
    const provider = byId[model.provider];
    if (!provider) continue;
    const entry = modelState(modelId);
    if (!usable(entry)) continue;
    const cred = pickCred(cfg, provider, previous?.label);
    if (!cred) continue;

    const { body: attemptBody, compaction } = await compactForAttempt(cfg, model, cred, body);
    const out = await attemptNonStream(cfg, model, cred, attemptBody);
    attempts.push({ model: modelId, cred: cred.label, kind: out.ok ? 'ok' : out.kind, status: out.status, ms: out.ms });

    if (out.ok) {
      recordSuccess(entry, out.ms);
      recordUsage({ model: modelId, provider: model.provider, ok: true, ms: out.ms, ...tokensOf(out.text), keyId: meta.keyId, keyLabel: meta.keyLabel, attemptIndex: attempts.length - 1 });
      state.sticky.set(requested, { modelId, label: cred.label, at: Date.now() });
      bus.emit('route', { requested, model: modelId, provider: model.provider, ok: true, ms: out.ms, attempts: attempts.length });
      const verdict = await verifyResponse(cfg, body, out.text);
      if (verdict.action === 'block') {
        logger.warn('tool call blocked by decision plane', { requested, model: modelId, prob: verdict.prob });
        return httpErr(403, `Tool call rejected by decision plane (justified probability ${verdict.prob}).`, 'tool_call_blocked', attempts);
      }
      let text = verdict.action === 'flag' ? markFlagged(out.text, verdict.prob) : out.text;
      if (verdict.action === 'flag') logger.warn('tool call flagged by decision plane', { requested, model: modelId, prob: verdict.prob });
      text = markCompacted(text, compaction);
      return {
        status: 200,
        text,
        attempts,
        compaction,
        route: { requested, model: modelId, provider: model.provider, cred: cred.label },
      };
    }

    applyFailure(cfg, provider, model, entry, cred, out.kind, { status: out.status, kind: out.kind, text: out.text, model: modelId });
    recordUsage({ model: modelId, provider: model.provider, ok: false, keyId: meta.keyId, keyLabel: meta.keyLabel, attemptIndex: attempts.length - 1 });
    bus.emit('route', {
      requested, model: modelId, provider: model.provider, ok: false,
      kind: out.kind, status: out.status, ms: out.ms, attempts: attempts.length,
    });
    logger.warn('attempt failed', {
      requested, model: modelId, kind: out.kind, status: out.status, ms: out.ms,
      detail: out.status > 0 ? String(out.text ?? '').slice(0, 300) : out.error,
    });
  }
  return giveUp(requested, attempts);
}

async function runStream(cfg, body, orderedIds, requested, previous, meta) {
  const attempts = [];
  for (const modelId of orderedIds.slice(0, MAX_ATTEMPTS)) {
    const model = getModel(modelId);
    if (!model) continue;
    const provider = byId[model.provider];
    if (!provider) continue;
    const entry = modelState(modelId);
    if (!usable(entry)) continue;
    const cred = pickCred(cfg, provider, previous?.label);
    if (!cred) continue;

    const { body: attemptBody, compaction } = await compactForAttempt(cfg, model, cred, body);
    const out = await attemptStream(cfg, model, cred, attemptBody);
    attempts.push({ model: modelId, cred: cred.label, kind: out.ok ? 'ok' : out.kind, status: out.status, ms: out.ms });

    if (out.ok) {
      // First byte has not been sent to the client yet — from here the route
      // is immutable (no failover mid-stream).
      recordSuccess(entry, out.ms);
      recordUsage({ model: modelId, provider: model.provider, ok: true, ms: out.ms, keyId: meta.keyId, keyLabel: meta.keyLabel, attemptIndex: attempts.length - 1 });
      state.sticky.set(requested, { modelId, label: cred.label, at: Date.now() });
      bus.emit('route', { requested, model: modelId, provider: model.provider, ok: true, ms: out.ms, attempts: attempts.length, stream: true });
      return {
        streaming: true,
        upstream: out.res,
        attempts,
        compaction,
        route: { requested, model: modelId, provider: model.provider, cred: cred.label },
      };
    }

    applyFailure(cfg, provider, model, entry, cred, out.kind, { status: out.status, kind: out.kind, text: out.text, model: modelId });
    recordUsage({ model: modelId, provider: model.provider, ok: false, keyId: meta.keyId, keyLabel: meta.keyLabel, attemptIndex: attempts.length - 1 });
    bus.emit('route', {
      requested, model: modelId, provider: model.provider, ok: false,
      kind: out.kind, status: out.status, ms: out.ms, attempts: attempts.length, stream: true,
    });
    logger.warn('stream attempt failed', {
      requested, model: modelId, kind: out.kind, status: out.status, ms: out.ms,
      detail: out.status > 0 ? String(out.text ?? '').slice(0, 300) : out.error,
    });
  }
  return giveUp(requested, attempts);
}

function giveUp(requested, attempts) {
  const trail = attempts.map((a) => `${a.model}:${a.kind}`).join(' → ') || 'none';
  return httpErr(502, `No healthy free backend for "${requested}". Attempts: ${trail}`, 'no_available_model', attempts);
}

export async function runChat(cfg, body, meta = {}) {
  const req = classifyRequest(body);
  if (!req.valid) return httpErr(400, '`messages` must be an array', 'invalid_messages');
  const requested = typeof body.model === 'string' && body.model ? body.model : '';
  if (!requested) return httpErr(400, '`model` is required', 'model_required');

  const anyCreds = Object.values(byId).some(
    (p) => p.isEnabled?.(cfg) && (p.listCredentials?.(cfg)?.length ?? 0) > 0,
  );
  if (!anyCreds) {
    return httpErr(
      503,
      'No provider credentials configured. Paste a key in config.json (providers.<name>.keys) or set FREE_ROUTER_<PROVIDER>_KEYS.',
      'no_credentials',
    );
  }

  state.lastRequestAt = Date.now();

  const pool = healthyCandidates();
  if (pool.length === 0) return httpErr(502, 'No free model is currently available.', 'no_available_model');

  const target = resolveRequested(cfg, requested);
  if (target.via !== 'exact') {
    logger.info('request rerouted by selection policy', { requested, target: target.id, via: target.via });
  }
  const previous = state.sticky.get(requested) ?? null;
  const orderedIds = await orderCandidates(cfg, body, target, pool, previous);
  const personaMessages = withPersona(cfg, body.messages);
  const chatBody = personaMessages === body.messages ? body : { ...body, messages: personaMessages };

  if (cfg.decision?.enabled === true && cfg.decision.rankHints === true) {
    // Fire-and-forget, sampled inside — never on the critical path.
    void maybeRankHints(cfg, {
      requested,
      candidates: orderedIds.slice(0, 8).map((id) => {
        const s = modelState(id);
        const total = s.ok + s.fail;
        return { id, successRate: total > 0 ? Number((s.ok / total).toFixed(2)) : null, latencyMs: s.latencyMs };
      }),
    });
  }

  if (req.stream) return runStream(cfg, chatBody, orderedIds, requested, previous, meta);
  return runNonStream(cfg, chatBody, orderedIds, requested, previous, meta);
}
