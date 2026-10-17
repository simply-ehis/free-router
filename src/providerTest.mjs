// @body:organ=face type=dashboard role="provider key testing: minimal authenticated chat ping per provider — validates installed or candidate keys before save; never persisted"
import { byId } from './providers/index.mjs';
import { getState as getCatalog } from './catalog.mjs';
import { maskKey } from './config.mjs';

const TEST_TIMEOUT_MS = 8_000;
const LIST_TIMEOUT_MS = 6_000;
// Custom endpoints keep their own probe (openai-compat probe button in the UI).
const NATIVE_IDS = ['zen', 'openrouter', 'groq', 'gemini', 'cerebras', 'sambanova', 'mistral'];

function newestCred(cfg, provider) {
  const creds = byId[provider].listCredentials(cfg) ?? [];
  // Prefer a real installed key (that is what the button validates); the
  // anonymous lane only fills in when the provider carries no keys at all.
  const installed = creds.filter((c) => c.source !== 'anonymous');
  return installed.at(-1) ?? creds.at(-1) ?? null;
}

// The catalog already knows each provider's models (keyless listing at refresh);
// fall back to one live keyless listing when the catalog is cold.
async function modelFor(cfg, provider) {
  const fromCatalog = getCatalog().models.filter((m) => m.provider === provider).map((m) => m.id);
  if (fromCatalog.length) return fromCatalog[0];
  try {
    const ids = await byId[provider].listModelIds(cfg, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    return ids[0] ?? null;
  } catch {
    return null;
  }
}

export async function testProviders(cfg, body) {
  const requested = body?.provider;
  if (requested !== undefined && (typeof requested !== 'string' || !NATIVE_IDS.includes(requested))) {
    return { error: `provider must be one of: ${NATIVE_IDS.join(', ')}` };
  }
  if (body?.key !== undefined && (typeof body.key !== 'string' || !body.key.trim() || body.key.length > 512)) {
    return { error: '`key` must be 1-512 characters when provided' };
  }
  const providedKey = typeof body?.key === 'string' && body.key.trim() ? body.key.trim() : null;
  const ids = requested ? [requested] : NATIVE_IDS.filter((id) => byId[id].isEnabled(cfg));
  const results = await Promise.all(ids.map((id) => testOne(cfg, id, providedKey)));
  return { results };
}

async function testOne(cfg, provider, providedKey) {
  const started = Date.now();
  const cred = providedKey ? { key: providedKey } : newestCred(cfg, provider);
  const base = {
    provider,
    keyMasked: cred ? maskKey(cred.key) : null,
    keySource: providedKey ? 'provided' : (cred ? 'installed' : 'none'),
  };
  if (!cred) return { ...base, ok: false, error: 'no key configured', errorKind: 'nokey', ms: Date.now() - started };
  const model = await modelFor(cfg, provider);
  if (!model) return { ...base, ok: false, error: 'no known model to test with — check network', errorKind: 'nomodel', ms: Date.now() - started };
  try {
    const res = await byId[provider].chat(
      cfg,
      cred,
      { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
      { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) },
    );
    const text = await res.text().catch(() => ''); // always drain: keeps sockets clean
    if (res.ok) return { ...base, ok: true, model, ms: Date.now() - started };
    let message = `HTTP ${res.status}`;
    try { message = JSON.parse(text)?.error?.message ?? message; } catch { /* keep default */ }
    return { ...base, ok: false, model, error: message, errorKind: byId[provider].classifyError(res.status, text), ms: Date.now() - started };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ...base,
      ok: false,
      model,
      error: timedOut ? 'timed out' : (err?.message ?? 'unreachable'),
      errorKind: timedOut ? 'timeout' : 'network',
      ms: Date.now() - started,
    };
  }
}
