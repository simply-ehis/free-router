// @body:organ=immune type=security role="failed-login lockout: per-IP exponential backoff + global soft cap (in-memory, per isolate)"
import { logger } from './util/log.mjs';

const byIp = new Map(); // ip -> { count, strikes, until, last }
const globalFails = [];
const GLOBAL_WINDOW_MS = 600_000;
const GLOBAL_LOCK_MS = 300_000;
const IDLE_FORGET_MS = 24 * 3_600_000;
let globalUntil = 0;

const maxFailures = (cfg) => cfg?.security?.maxLoginFailures ?? 5;

function sweep(now) {
  for (const [ip, e] of byIp) if (now - e.last > IDLE_FORGET_MS && now > e.until) byIp.delete(ip);
}

// { locked, retryAfterSec } — checked BEFORE verifying a password so a locked
// client cannot keep guessing.
export function lockState(ip, now = Date.now()) {
  const until = Math.max(byIp.get(ip)?.until ?? 0, globalUntil);
  return until > now ? { locked: true, retryAfterSec: Math.max(1, Math.ceil((until - now) / 1000)) } : { locked: false, retryAfterSec: 0 };
}

// Per-IP: after N consecutive failures lock for 1 min, doubling on each repeat
// (capped at 1h). Global: a flood of failures from many IPs locks password
// attempts for everyone for 5 minutes — signed-in cookies keep working.
export function noteFailure(cfg, ip, now = Date.now()) {
  sweep(now);
  const e = byIp.get(ip) ?? { count: 0, strikes: 0, until: 0, last: now };
  e.count += 1;
  e.last = now;
  if (e.count >= maxFailures(cfg)) {
    e.strikes += 1;
    e.count = 0;
    e.until = now + Math.min(3_600_000, 60_000 * 2 ** (e.strikes - 1));
    logger.warn('login locked', { ip, strikes: e.strikes, seconds: Math.round((e.until - now) / 1000) });
  }
  byIp.set(ip, e);
  globalFails.push(now);
  while (globalFails.length > 0 && now - globalFails[0] > GLOBAL_WINDOW_MS) globalFails.shift();
  if (globalFails.length >= maxFailures(cfg) * 6 && globalUntil <= now) {
    globalUntil = now + GLOBAL_LOCK_MS;
    logger.warn('login globally locked', { failures: globalFails.length });
  }
  return lockState(ip, now);
}

export function noteSuccess(ip) {
  const e = byIp.get(ip);
  if (e) { e.count = 0; e.strikes = 0; e.until = 0; }
}

export function resetAuthGuard() {
  byIp.clear();
  globalFails.length = 0;
  globalUntil = 0;
}
