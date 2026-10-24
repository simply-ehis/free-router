// @body:organ=immune role="load/validate/atomic-write config; opencode auth.json import"
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { store } from './store.mjs';

let ROOT;
try {
  ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
} catch {
  ROOT = '/';
}
export { ROOT };
// FREE_ROUTER_CONFIG lets tests (and multi-instance setups) point at another
// config file without touching the real one.
export const CONFIG_PATH = process.env.FREE_ROUTER_CONFIG || path.join(ROOT, 'config.json');
export const API_KEYS_PATH = path.join(path.dirname(CONFIG_PATH), '.cache', 'client-api-keys.json');
export const COMPAT_CREDENTIALS_PATH = path.join(path.dirname(CONFIG_PATH), '.cache', 'compat-provider-credentials.json');
export const PROVIDER_CREDENTIALS_PATH = path.join(path.dirname(CONFIG_PATH), '.cache', 'provider-credentials.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');
const VERIFY_MODES = ['off', 'flag', 'block'];

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    const example = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));
    example.dashboardPassword = `pass-${randomBytes(24).toString('base64url')}`;
    saveConfig(example);
    console.log(`[free-router] created config.json (dashboard password saved there)`);
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = raw.dashboardPassword ? raw : { ...raw, dashboardPassword: raw.apiKey };
  delete cfg.apiKey;
  if (process.env.DASHBOARD_PASSWORD || process.env.GATEWAY_KEY) cfg.dashboardPassword = process.env.DASHBOARD_PASSWORD || process.env.GATEWAY_KEY;
  // Config schema evolves additively: fill missing fields from the example so old
  // config.json files never brick startup. User values always win.
  const example = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));
  const merged = deepMerge(example, cfg);
  if (JSON.stringify(merged) !== JSON.stringify(cfg)) saveConfig(merged);
  applyEnvKeys(merged);
  try { merged.apiKeys = JSON.parse(store.read(API_KEYS_PATH) ?? '[]'); } catch { merged.apiKeys = []; }
  validateConfig(merged);
  return merged;
}

// Production key input, all runtime overlays (never written to config.json):
//   FREE_ROUTER_<PROVIDER>_KEYS  comma-separated, works for every provider
//   conventional provider vars   OPENROUTER_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY
// plus automatic opencode auth.json detection (providers.zen.importOpencodeAuth).
const ENV_KEY_VARS = {
  zen: ['FREE_ROUTER_ZEN_KEYS'],
  openrouter: ['FREE_ROUTER_OPENROUTER_KEYS', 'OPENROUTER_API_KEY'],
  groq: ['FREE_ROUTER_GROQ_KEYS', 'GROQ_API_KEY'],
  gemini: ['FREE_ROUTER_GEMINI_KEYS', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  cerebras: ['FREE_ROUTER_CEREBRAS_KEYS', 'CEREBRAS_API_KEY'],
  sambanova: ['FREE_ROUTER_SAMBANOVA_KEYS', 'SAMBANOVA_API_KEY'],
  mistral: ['FREE_ROUTER_MISTRAL_KEYS', 'MISTRAL_API_KEY'],
  kilo: ['FREE_ROUTER_KILO_KEYS', 'KILO_API_KEY'],
  ovh: ['FREE_ROUTER_OVH_KEYS', 'OVH_AI_ENDPOINTS_ACCESS_TOKEN', 'AI_ENDPOINT_API_KEY'],
  llm7: ['FREE_ROUTER_LLM7_KEYS', 'LLM7_API_KEY'],
  zai: ['FREE_ROUTER_ZAI_KEYS', 'ZAI_API_KEY', 'Z_AI_API_KEY'],
  nvidia: ['FREE_ROUTER_NVIDIA_KEYS', 'NVIDIA_API_KEY'],
  qwen: ['FREE_ROUTER_QWEN_KEYS', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
  kluster: ['FREE_ROUTER_KLUSTER_KEYS', 'KLUSTER_API_KEY'],
  huggingface: ['FREE_ROUTER_HF_KEYS', 'HF_TOKEN', 'HUGGINGFACE_API_KEY'],
};

function applyEnvKeys(cfg, env = process.env) {
  for (const [name, p] of Object.entries(cfg.providers ?? {})) {
    const vars = ENV_KEY_VARS[name] ?? [`FREE_ROUTER_${name.toUpperCase()}_KEYS`];
    const detected = vars.flatMap((v) => (env[v] ?? '').split(','));
    const keys = detected.map((s) => s.trim()).filter(Boolean);
    if (keys.length > 0) p.keys = [...new Set([...(p.keys ?? []), ...keys])];
  }
  return cfg;
}
export { applyEnvKeys };

export function deepMerge(base, over) {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function saveConfig(cfg) {
  validateConfig(cfg);
  store.write(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// Awaited variant for dashboard writes: on Workers the KV put must finish
// before the response goes out, or the setting silently evaporates.
export async function saveConfigDurable(cfg) {
  validateConfig(cfg);
  await store.writeDurable(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function validateConfig(cfg) {
  const fail = (msg) => { throw new Error(`config invalid: ${msg}`); };
  if (typeof cfg !== 'object' || cfg === null) fail('root must be an object');
  if (typeof cfg.host !== 'string' || !cfg.host) fail('host must be a non-empty string');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) fail('port must be 1-65535');
  const password = cfg.dashboardPassword ?? cfg.apiKey;
  if (typeof password !== 'string' || password.length < 8) fail('dashboardPassword must be a string of 8+ chars');
  if (cfg.apiKeys !== undefined && (!Array.isArray(cfg.apiKeys) || cfg.apiKeys.some((k) => typeof k?.id !== 'string' || !k.id || typeof k?.label !== 'string' || !k.label || !/^[a-f0-9]{64}$/.test(k?.hash ?? '') || typeof k?.createdAt !== 'string' || (k.enabled !== undefined && typeof k.enabled !== 'boolean')))) fail('apiKeys must contain valid hashed client key records');
  if (typeof cfg.selection?.strategy !== 'string' || !cfg.selection.strategy) fail('selection.strategy required');
  for (const [k, v] of Object.entries(cfg.selection?.weights ?? {})) {
    if (typeof v !== 'number' || v < 0 || v > 1) fail(`selection.weights.${k} must be 0-1`);
  }
  if (cfg.selection?.blacklist !== undefined && (!Array.isArray(cfg.selection.blacklist) || cfg.selection.blacklist.some((id) => typeof id !== 'string' || !id))) fail('selection.blacklist must be a string[]');
  if (cfg.selection?.priorities !== undefined) {
    if (typeof cfg.selection.priorities !== 'object' || cfg.selection.priorities === null || Array.isArray(cfg.selection.priorities)) fail('selection.priorities must be an object');
    for (const [id, value] of Object.entries(cfg.selection.priorities)) {
      if (typeof value !== 'number' || value < 0 || value > 1) fail('selection.priorities.' + id + ' must be 0-1');
    }
  }
  if (cfg.selection?.forceChat !== undefined && (!Array.isArray(cfg.selection.forceChat) || cfg.selection.forceChat.some((id) => typeof id !== 'string' || !id))) fail('selection.forceChat must be a string[]');
  if (cfg.selection?.defaultModel !== undefined && typeof cfg.selection.defaultModel !== 'string') fail('selection.defaultModel must be a string ("" = no default)');
  if (cfg.selection?.aliases !== undefined) {
    if (typeof cfg.selection.aliases !== 'object' || cfg.selection.aliases === null || Array.isArray(cfg.selection.aliases)) fail('selection.aliases must be an object');
    for (const [alias, target] of Object.entries(cfg.selection.aliases)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)) fail(`selection.aliases key "${alias}" must be 1-64 chars of letters/digits/._-`);
      if (typeof target !== 'string' || !target.trim()) fail(`selection.aliases.${alias} must be a non-empty model id`);
    }
  }
  if (!Number.isInteger(cfg.selection?.timeboxMs) || cfg.selection.timeboxMs < 50) fail('selection.timeboxMs must be int >= 50');
  if (!Number.isInteger(cfg.selection?.attemptTimeoutMs) || cfg.selection.attemptTimeoutMs < 1000) fail('selection.attemptTimeoutMs must be int >= 1000');
  if (cfg.selection?.pool !== undefined && cfg.selection.pool !== 'all' && cfg.selection.pool !== 'free') fail("selection.pool must be 'all' or 'free'");
  for (const [name, p] of Object.entries(cfg.providers ?? {})) {
    if (typeof p.enabled !== 'boolean') fail(`providers.${name}.enabled must be boolean`);
    // openai-compat carries credentials per-instance, not in a keys[] array
    if (name !== 'openai-compat') {
      if (!Array.isArray(p.keys) || p.keys.some((k) => typeof k !== 'string' && (typeof k?.key !== 'string' || typeof k?.enabled !== 'boolean'))) {
        fail(`providers.${name}.keys must be (string | {key,enabled})[]`);
      }
    }
    if (p.baseUrl !== undefined && p.baseUrl !== '' && (typeof p.baseUrl !== 'string' || !/^https?:\/\//.test(p.baseUrl))) {
      fail(`providers.${name}.baseUrl must be empty or an http(s) URL`);
    }
  }
  if (cfg.security !== undefined) {
    if (!Number.isInteger(cfg.security?.rateLimitPerMin) || cfg.security.rateLimitPerMin < 0) fail('security.rateLimitPerMin must be int >= 0 (0 = off)');
    if (!Array.isArray(cfg.security?.allowedIps) || cfg.security.allowedIps.some((ip) => typeof ip !== 'string' || !ip)) fail('security.allowedIps must be string[]');
    if (cfg.security.sessionHours !== undefined && (!Number.isInteger(cfg.security.sessionHours) || cfg.security.sessionHours < 1 || cfg.security.sessionHours > 720)) fail('security.sessionHours must be int 1-720');
    if (cfg.security.sessionEpoch !== undefined && (!Number.isInteger(cfg.security.sessionEpoch) || cfg.security.sessionEpoch < 0)) fail('security.sessionEpoch must be a non-negative int');
    if (cfg.security.maxLoginFailures !== undefined && (!Number.isInteger(cfg.security.maxLoginFailures) || cfg.security.maxLoginFailures < 3 || cfg.security.maxLoginFailures > 50)) fail('security.maxLoginFailures must be int 3-50');
  }
  if (cfg.stealth !== undefined) {
    if (typeof cfg.stealth?.enabled !== 'boolean') fail('stealth.enabled must be boolean');
    if (typeof cfg.stealth?.alias !== 'string' || !cfg.stealth.alias) fail('stealth.alias must be a non-empty string');
    if (typeof cfg.stealth?.scrubContent !== 'boolean') fail('stealth.scrubContent must be boolean');
  }
  if (cfg.persona !== undefined) {
    if (typeof cfg.persona?.enabled !== 'boolean') fail('persona.enabled must be boolean');
    if (typeof cfg.persona?.prependClientSystem !== 'boolean') fail('persona.prependClientSystem must be boolean');
    if (typeof cfg.persona?.prompt !== 'string') fail('persona.prompt must be a string');
  }
  if (cfg.compaction !== undefined) {
    if (!['summarize', 'truncate-oldest'].includes(cfg.compaction?.strategy)) fail('compaction.strategy must be summarize|truncate-oldest');
    if (!Number.isInteger(cfg.compaction?.summarizeTimeoutMs) || cfg.compaction.summarizeTimeoutMs < 1000) fail('compaction.summarizeTimeoutMs must be int >= 1000');
  }
  if (cfg.contextWindows !== undefined) {
    if (typeof cfg.contextWindows !== 'object' || cfg.contextWindows === null || Array.isArray(cfg.contextWindows)) fail('contextWindows must be an object');
    for (const [k, v] of Object.entries(cfg.contextWindows)) {
      if (!Number.isInteger(v) || v < 256) fail(`contextWindows.${k} must be int >= 256`);
    }
  }
  if (!VERIFY_MODES.includes(cfg.decision?.toolVerify)) fail(`decision.toolVerify must be one of ${VERIFY_MODES.join('|')}`);
  if (typeof cfg.decision?.enabled !== 'boolean') fail('decision.enabled must be boolean');
  if (typeof cfg.decision?.model !== 'string' || !cfg.decision.model) fail('decision.model must be a non-empty string');
  for (const k of ['classify', 'diagnose', 'rankHints', 'expose']) {
    if (typeof cfg.decision?.[k] !== 'boolean') fail(`decision.${k} must be boolean`);
  }
  if (cfg.decision?.baseUrl !== undefined && cfg.decision.baseUrl !== '' && (typeof cfg.decision.baseUrl !== 'string' || !/^https?:\/\//.test(cfg.decision.baseUrl))) {
    fail('decision.baseUrl must be empty or an http(s) URL');
  }
  if (!Number.isInteger(cfg.probe?.intervalMs) || cfg.probe.intervalMs < 1000) fail('probe.intervalMs must be int >= 1000');
  if (!Number.isInteger(cfg.probe?.standbyWarm) || cfg.probe.standbyWarm < 0 || cfg.probe.standbyWarm > 10) fail('probe.standbyWarm must be int 0-10');
  if (cfg.probe?.sweepIntervalMs !== undefined && (!Number.isInteger(cfg.probe.sweepIntervalMs) || cfg.probe.sweepIntervalMs < 60_000)) fail('probe.sweepIntervalMs must be int >= 60000 (0 = off)');
  if (cfg.probe?.sweepActiveWindowMs !== undefined && (!Number.isInteger(cfg.probe.sweepActiveWindowMs) || cfg.probe.sweepActiveWindowMs < 60_000)) fail('probe.sweepActiveWindowMs must be int >= 60000');
  if (!Number.isInteger(cfg.refresh?.catalogMinutes) || cfg.refresh.catalogMinutes < 1) fail('refresh.catalogMinutes must be int >= 1');
  if (cfg.autoDiscover !== undefined && typeof cfg.autoDiscover !== 'boolean') fail('autoDiscover must be boolean');
  const compat = cfg.providers?.['openai-compat'];
  if (compat !== undefined) {
    if (compat.enabled !== undefined && typeof compat.enabled !== 'boolean') fail('openai-compat.enabled must be boolean');
    if (compat.instances !== undefined) {
      if (!Array.isArray(compat.instances)) fail('openai-compat.instances must be an array');
      compat.instances.forEach((inst, i) => {
        if (typeof inst?.baseUrl !== 'string' || !/^https?:\/\//.test(inst.baseUrl)) fail(`openai-compat.instances[${i}].baseUrl must be an http(s) URL`);
        if (inst.apiKey !== undefined && typeof inst.apiKey !== 'string') fail(`openai-compat.instances[${i}].apiKey must be a string`);
        if (inst.name !== undefined && (typeof inst.name !== 'string' || !inst.name.trim())) fail(`openai-compat.instances[${i}].name must be a non-empty string`);
        if (inst.enabled !== undefined && typeof inst.enabled !== 'boolean') fail(`openai-compat.instances[${i}].enabled must be boolean`);
        if (inst.prefix !== undefined && (typeof inst.prefix !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(inst.prefix))) fail(`openai-compat.instances[${i}].prefix must be lowercase alphanumeric/dash`);
        if (inst.models !== undefined && (!Array.isArray(inst.models) || inst.models.some((m) => typeof m !== 'string'))) fail(`openai-compat.instances[${i}].models must be a string array`);
      });
    }
  }
  return true;
}

// Returns the Zen key opencode stored on disk, or null. Value never logged.
export function importOpencodeZenKey() {
  const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    const key = auth?.opencode?.key;
    return typeof key === 'string' && key.length > 10 ? key : null;
  } catch {
    return null;
  }
}

// Shows just enough to tell keys apart: 4 + 4 characters, and nothing at all
// for keys too short to hide behind that.
export function maskKey(key) {
  if (typeof key !== 'string' || key.length < 16) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// Normalizes provider key entries: legacy string or {key, enabled}. `idx` is the
// 1-based position in the raw array (stable labels even when a key is disabled).
export function providerKeyEntries(p) {
  return (p?.keys ?? [])
    .map((raw, i) => ({
      idx: i + 1,
      key: typeof raw === 'string' ? raw : raw?.key,
      enabled: typeof raw === 'string' ? true : raw?.enabled !== false,
    }))
    .filter((e) => typeof e.key === 'string' && e.key.length > 0);
}

export function enabledKeyEntries(p) {
  return providerKeyEntries(p).filter((e) => e.enabled);
}
