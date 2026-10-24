// @body:organ=muscle type=compat role="custom openai-compat endpoints: parse/validate base URL, probe a not-yet-saved endpoint, add instance with encrypted worker credential persistence"
import { COMPAT_CREDENTIALS_PATH, saveConfigDurable } from './config.mjs';
import { store } from './store.mjs';
import { logger } from './util/log.mjs';
import { isWorkerRuntime } from './runtime.mjs';
import { hasCompatCredentialsKey, persistCompatCredentials } from './compatCredentials.mjs';

function isPrivateHost(rawHost) {
  const h = rawHost.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  return h.includes(':') && (h === '::1' || h === '::' || /^f[cd]/.test(h) || h.startsWith('fe80'));
}

// Shared endpoint validation for add + probe: http(s) only, no embedded
// credentials/query, bounded length. Your upstream key travels with every
// request, so plain http is only accepted for local/private hosts, and a cloud
// deployment refuses private hosts outright (it cannot reach them, and probing
// them is how SSRF is done).
export function parseCompatBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return { error: '`baseUrl` is required' };
  if (value.length > 2048) return { error: '`baseUrl` is too long' };
  let url;
  try { url = new URL(value.trim()); } catch { return { error: '`baseUrl` must be a valid http(s) URL' }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return { error: '`baseUrl` must be an http(s) URL without credentials or query values' };
  }
  const privateHost = isPrivateHost(url.hostname);
  if (privateHost && isWorkerRuntime()) return { error: 'This router runs on Cloudflare and cannot reach local or private addresses — use a public https URL' };
  if (url.protocol === 'http:' && !privateHost) return { error: 'Use https:// — your upstream key would travel in clear text over http' };
  return { url, base: url.href.replace(/\/+$/, '') };
}

// Time-boxed model listing against a not-yet-saved endpoint. The key is used
// for this call only — never stored, never logged.
export async function probeCompatEndpoint(body) {
  const parsed = parseCompatBaseUrl(body.baseUrl);
  if (parsed.error) return { error: parsed.error };
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') return { error: '`apiKey` must be a string' };
  const started = Date.now();
  try {
    const res = await fetch(`${parsed.base}/models`, {
      signal: AbortSignal.timeout(15_000),
      headers: body.apiKey ? { authorization: `Bearer ${body.apiKey}` } : {},
    });
    const text = await res.text();
    let ids = [];
    try { ids = (JSON.parse(text)?.data ?? []).map((m) => m?.id).filter((v) => typeof v === 'string'); } catch { /* non-JSON listing */ }
    return {
      ok: res.ok,
      status: res.status,
      count: ids.length,
      models: ids.slice(0, 50),
      ms: Date.now() - started,
      ...(res.ok ? {} : { error: `endpoint answered HTTP ${res.status}` }),
    };
  } catch (err) {
    return { ok: false, count: 0, models: [], ms: Date.now() - started, error: err?.name === 'TimeoutError' ? 'endpoint timed out' : (err?.message ?? 'endpoint unreachable') };
  }
}

export async function addCompatInstance(cfg, body) {
  if (typeof body.name !== 'string' || !body.name.trim()) return { error: '`name` is required' };
  const parsed = parseCompatBaseUrl(body.baseUrl);
  if (parsed.error) return { error: parsed.error };
  if (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 512) return { error: '`apiKey` must be 1-512 characters' };
  if (isWorkerRuntime() && !hasCompatCredentialsKey()) return { status: 503, error: 'Cloudflare encrypted credential storage is not configured' };
  const name = body.name.trim().slice(0, 64);
  const prefix = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  if (!prefix) return { error: '`name` needs at least one letter or number' };
  const provider = cfg.providers['openai-compat'];
  if (provider.instances.some((inst) => inst.prefix === prefix)) return { error: 'A compatible endpoint with this name already exists' };
  const instance = { name, prefix, baseUrl: parsed.base, apiKey: body.apiKey.trim(), enabled: true };
  provider.enabled = true;
  provider.instances.push(instance);
  if (isWorkerRuntime()) {
    try { await persistCompatCredentials(provider.instances, store, COMPAT_CREDENTIALS_PATH); }
    catch (err) { provider.instances.pop(); logger.error('encrypted endpoint credential save failed', { error: err.message }); return { status: 503, error: 'Could not securely save this endpoint key to Cloudflare KV' }; }
  }
  await saveConfigDurable(cfg);
  return { instance: { name, prefix, baseUrl: instance.baseUrl } };
}

// Instance listing without secrets; toggle/remove also re-persist worker credentials.
export function listCompatInstances(cfg) {
  return (cfg.providers['openai-compat'].instances ?? []).map((inst) => ({ name: inst.name, prefix: inst.prefix, baseUrl: inst.baseUrl, enabled: inst.enabled !== false }));
}

export async function toggleCompatInstance(cfg, prefix, enabled) {
  const provider = cfg.providers['openai-compat'];
  const inst = provider.instances.find((i) => i.prefix === prefix);
  if (!inst) return { status: 404, error: 'Unknown compatible endpoint' };
  inst.enabled = enabled;
  if (isWorkerRuntime()) {
    try { await persistCompatCredentials(provider.instances, store, COMPAT_CREDENTIALS_PATH); }
    catch (err) { inst.enabled = !enabled; logger.error('encrypted endpoint credential update failed', { error: err.message }); return { status: 503, error: 'Could not update encrypted endpoint keys in Cloudflare KV' }; }
  }
  await saveConfigDurable(cfg);
  return { instance: { name: inst.name, prefix: inst.prefix, baseUrl: inst.baseUrl, enabled: inst.enabled !== false } };
}

export async function removeCompatInstance(cfg, prefix) {
  const provider = cfg.providers['openai-compat'];
  const before = provider.instances;
  provider.instances = before.filter((instance) => instance.prefix !== prefix);
  if (provider.instances.length === before.length) return { status: 404, error: 'Unknown compatible endpoint' };
  if (isWorkerRuntime()) {
    try { await persistCompatCredentials(provider.instances, store, COMPAT_CREDENTIALS_PATH); }
    catch (err) { provider.instances = before; logger.error('encrypted endpoint credential removal failed', { error: err.message }); return { status: 503, error: 'Could not update encrypted endpoint keys in Cloudflare KV' }; }
  }
  await saveConfigDurable(cfg);
  return {};
}
