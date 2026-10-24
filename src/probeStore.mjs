// @body:organ=muscle type=probe role="persist per-model check results (working/limited/failing) so a recycled Worker isolate or a restart does not forget which models work"
import path from 'node:path';
import { CONFIG_PATH } from './config.mjs';

export const PROBE_STATE_PATH = path.join(path.dirname(CONFIG_PATH), '.cache', 'probe-state.json');

const MAX_ENTRIES = 800;
const MAX_AGE_MS = 7 * 24 * 3_600_000; // week-old health is misleading; forget it

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

function latestSignal(e) {
  return Math.max(e.lastOk, e.lastErr?.at ?? 0, e.lastLimited, e.checkedAt);
}

// Map<id, entry> → JSON text. Only models that were actually checked are kept.
export function serializeProbeState(map, now = Date.now()) {
  const rows = [];
  for (const [id, e] of map) {
    if (latestSignal(e) === 0 || now - latestSignal(e) > MAX_AGE_MS) continue;
    rows.push([id, {
      lastOk: e.lastOk, lastErr: e.lastErr, lastMs: e.lastMs, lastLimited: e.lastLimited, checkedAt: e.checkedAt,
      lastWarmAt: e.lastWarmAt, okCount: e.okCount, failCount: e.failCount,
    }]);
  }
  rows.sort((a, b) => latestSignal(b[1]) - latestSignal(a[1]));
  return JSON.stringify(Object.fromEntries(rows.slice(0, MAX_ENTRIES)));
}

// JSON text → Map<id, entry>. Anything malformed is skipped, never thrown.
export function parseProbeState(text, now = Date.now()) {
  const out = new Map();
  if (typeof text !== 'string' || !text) return out;
  let raw;
  try { raw = JSON.parse(text); } catch { return out; }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, e] of Object.entries(raw).slice(0, MAX_ENTRIES)) {
    if (!id || e === null || typeof e !== 'object') continue;
    const lastErr = e.lastErr && typeof e.lastErr === 'object' && typeof e.lastErr.kind === 'string'
      ? { kind: e.lastErr.kind.slice(0, 32), status: Number.isInteger(e.lastErr.status) ? e.lastErr.status : undefined, at: num(e.lastErr.at) }
      : null;
    const entry = {
      lastOk: num(e.lastOk), lastErr, lastWarmAt: num(e.lastWarmAt), okCount: num(e.okCount), failCount: num(e.failCount),
      lastMs: Number.isFinite(e.lastMs) && e.lastMs >= 0 ? e.lastMs : null, lastLimited: num(e.lastLimited), checkedAt: num(e.checkedAt),
    };
    if (latestSignal(entry) === 0 || now - latestSignal(entry) > MAX_AGE_MS) continue;
    out.set(id, entry);
  }
  return out;
}
