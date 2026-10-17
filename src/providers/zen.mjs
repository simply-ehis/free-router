// @body:organ=muscle type=provider role="OpenCode Zen adapter: creds, model list, chat, systemone, error classification"
import { randomInt } from 'node:crypto';
import { importOpencodeZenKey, enabledKeyEntries } from '../config.mjs';
import { mergeDiscovered } from '../discovery.mjs';

export const id = 'zen';
const DEFAULT_BASE = 'https://opencode.ai/zen/v1';
const LIST_TIMEOUT_MS = 30_000;

// Zen free-tier gate (2026-10-14 revision, community-verified live): the
// anonymous lane serves "Bearer public" — keyless requests are rejected — when
// the request fingerprints as the official client:
//   - User-Agent "opencode/<channel>/<version>/<name>"; older "opencode/<ver>"
//     forms get 403 FreeTierError (the version itself is not validated),
//   - session id ses_ + 12 hex chars of the DESCENDING time word
//     (~(ts<<12|counter) in a 48-bit word, tail lands in fc0-fff) + 14 base62;
//     ascending timestamps are rejected even in the right shape,
//   - x-opencode-session AND x-opencode-session-id both carrying that id
//     (both required), mirrored by x-session-affinity / X-Session-Id,
//   - body streamed with the official agent tool names present (see gateTools).
// x-opencode-request is REJECTED since 2026-10-14 — never send it. Sources:
// opencode2api gateway + dsh-plugin-adapter changelog (both live-probed).
// Constants overridable via config (providers.zen.clientUserAgent).
const DEFAULT_UA = 'opencode/latest/2.0.29/cli';
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// 36-bit millisecond word, shifted into the 48-bit descending layout with
// counter 1: the inverted low 12 bits read 0xffe — inside the accepted
// fc0-fff counter window the gate checks.
function newSessionId() {
  const ts36 = BigInt(Date.now()) & 0xFFFFFFFFFn;
  const inverted = (~(ts36 << 12n | 1n)) & 0xFFFFFFFFFFFn;
  const time = inverted.toString(16).padStart(12, '0');
  let rand = '';
  for (let i = 0; i < 14; i += 1) rand += B62[randomInt(B62.length)];
  return `ses_${time}${rand}`;
}
let sessionId = null;

function getSessionId() {
  if (!sessionId) sessionId = newSessionId();
  return sessionId;
}

function freeTierHeaders(cfg) {
  const zen = cfg?.providers?.zen ?? {};
  const sid = getSessionId();
  return {
    'user-agent': zen.clientUserAgent ?? DEFAULT_UA,
    'x-opencode-client': 'cli',
    // Non-canonical project values pass; canonical prj_* ids are rejected.
    'x-opencode-project': 'global',
    'x-opencode-session': sid,
    'x-opencode-session-id': sid,
    'x-session-affinity': sid,
    'X-Session-Id': sid,
  };
}

// baseUrl override supports proxies and the mock upstream used in tests.
function base(cfg) {
  const b = cfg?.providers?.zen?.baseUrl;
  return typeof b === 'string' && b ? b.replace(/\/+$/, '') : DEFAULT_BASE;
}

export function isEnabled(cfg) {
  return cfg.providers?.zen?.enabled === true;
}

export function listCredentials(cfg) {
  const creds = [];
  const zen = cfg.providers?.zen ?? {};
  if (zen.importOpencodeAuth) {
    const key = importOpencodeZenKey();
    if (key) creds.push({ provider: id, label: 'opencode-auth', key, source: 'opencode-auth' });
  }
  for (const e of enabledKeyEntries(zen)) {
    creds.push({ provider: id, label: `zen-${e.idx}`, key: e.key });
  }
  // The free lane is the anonymous lane: with the CLI fingerprint, Bearer
  // "public" serves the free models with no account at all — so zen works
  // zero-config. Saved account keys round-robin as bonus quota behind it.
  const merged = mergeDiscovered(id, cfg, creds);
  merged.push({ provider: id, label: 'anonymous', key: 'public', source: 'anonymous' });
  return merged;
}

// Zen serves models on three protocols; jev* is the System One decision endpoint
// and never participates in the chat pool.
export function protocolOf(modelId) {
  return modelId.startsWith('jev') ? 'systemone' : 'chat';
}

// Gate tools: the /zen/v1 free lane requires the official agent tool names to
// be present (bash + read minimum; the full core set mirrors the official
// client). Stub definitions pass — descriptions/schemas are not inspected on
// this lane (the /inference lane byte-compares genuine definitions; we do not
// use it). The engine strips any tool_call targeting a name it had to inject.
export const gateTools = ['bash', 'edit', 'glob', 'grep', 'read'];

function gateToolSchemas() {
  return gateTools.map((name) => ({
    type: 'function',
    function: { name, description: `Agent tool ${name}`, parameters: { type: 'object', properties: {} } },
  }));
}

// Client tools keep their shape; missing gate tools are appended. Upstream is
// always asked to stream — zen's free tier rejects non-streaming (403) — and
// usage reporting is enabled the way the official client does it.
export function ensureFreeTierBody(body) {
  const clientTools = Array.isArray(body.tools) ? body.tools : [];
  const clientNames = new Set(clientTools.map((t) => t?.function?.name).filter(Boolean));
  const missing = gateTools.filter((n) => !clientNames.has(n));
  const out = {
    ...body,
    stream: true,
    stream_options: { ...(body.stream_options ?? {}), include_usage: true },
  };
  if (missing.length > 0) out.tools = [...clientTools, ...gateToolSchemas()];
  return out;
}

export async function listModelIds(cfg, { signal } = {}) {
  const res = await fetch(`${base(cfg)}/models`, { signal: signal ?? AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`zen listModels HTTP ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((m) => m.id).filter(Boolean);
}

// Free rule for Zen: official "-free" suffix, known-free stealth models
// (big-pickle, test, etc. don't end in -free but are free), or models.dev
// cost == 0/0. Paid claude/gpt/gemini models must NOT match here even if
// models.dev temporarily lists them as $0 — they require valid credentials.
// freeTable: { [modelId]: true } precomputed from models.dev (may be null when offline).
const ZEN_FREE_STEALTH = new Set(['big-pickle', 'test']);
export function freeSources(modelId, freeTable) {
  const sources = [];
  if (modelId.endsWith('-free') || ZEN_FREE_STEALTH.has(modelId)) sources.push('suffix');
  if (freeTable?.[modelId]) sources.push('models.dev');
  return sources;
}

// Returns raw Response so callers can stream the body themselves.
export async function chat(cfg, cred, body, { signal } = {}) {
  return fetch(`${base(cfg)}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${cred.key}`,
      ...freeTierHeaders(cfg),
    },
    body: JSON.stringify(ensureFreeTierBody(body)),
  });
}

// Jev System One — keyless by design (jev-1.13-free route works without auth).
export async function systemone(cfg, body, { signal } = {}) {
  return fetch(`${base(cfg)}/systemone`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...freeTierHeaders(cfg) },
    body: JSON.stringify(body),
  });
}

// Called by the engine after a FreeTierError: fingerprint may have rotated
// server-side — mint a fresh session id for subsequent attempts.
export function rotateSession() {
  sessionId = newSessionId();
  return sessionId;
}

export function classifyError(status, text = '') {
  const t = text.toLowerCase();
  if (/freetier/.test(t)) return 'freetier';
  if (status === 410 || /deprecated/.test(t)) return 'deprecated';
  if (status === 402 || /insufficient|balance|payment|billing|credit/.test(t)) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'ratelimit';
  if (status === 404 || status === 400) return 'notfound';
  if (status >= 500) return 'transient';
  return 'unknown';
}
