// @body:organ=immune type=security role="gateway hardening: per-IP token-bucket rate limit, IP allowlist, security headers (Web-standard)"
import { logger } from './util/log.mjs';

const buckets = new Map(); // ip -> { tokens, ts }
let lastSweep = Date.now();

function rateLimitPerMin(cfg) {
  const n = cfg?.security?.rateLimitPerMin;
  return Number.isInteger(n) && n >= 0 ? n : 60;
}

function refill(bucket, perMin, now) {
  const elapsed = Math.max(0, now - bucket.ts);
  bucket.tokens = Math.min(perMin, bucket.tokens + (elapsed * perMin) / 60_000);
  bucket.ts = now;
}

// Token bucket per remote IP. capacity = rateLimitPerMin, refill = capacity/minute.
// Returns { allowed, retryAfterSec }.
export function consumeRate(cfg, ip) {
  const perMin = rateLimitPerMin(cfg);
  if (perMin === 0) return { allowed: true, retryAfterSec: 0 };
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    for (const [k, b] of buckets) if (now - b.ts > 600_000) buckets.delete(k);
    lastSweep = now;
  }
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { tokens: perMin, ts: now };
    buckets.set(ip, bucket);
  }
  refill(bucket, perMin, now);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSec: 0 };
  }
  const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / (perMin / 60_000) / 1000));
  return { allowed: false, retryAfterSec };
}

export function resetRateLimiter() {
  buckets.clear();
}

function normalizeIp(ip) {
  return typeof ip === 'string' && ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// Empty allowlist = allow all (localhost default). Non-empty = only listed IPs.
export function ipAllowed(cfg, ip) {
  const list = cfg?.security?.allowedIps ?? [];
  if (list.length === 0) return true;
  return list.includes(normalizeIp(ip));
}

// Web-standard remote IP: Cloudflare edge header (Workers only) wins,
// then the node adapter's x-local-ip (socket address). Client-supplied
// proxy headers are stripped in nodeToRequest, so they cannot spoof.
export function remoteIp(request) {
  const h = request.headers;
  const cf = h.get('cf-connecting-ip');
  if (cf) return normalizeIp(cf);
  const local = h.get('x-local-ip');
  return local ? normalizeIp(local) : 'local';
}

// Baseline hardening headers for every response; CSP only where HTML is served.
// Returns a plain header map to merge into any Response (node adapter included).
export function securityHeaders({ isApi = false, isHtml = false } = {}) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (isApi) headers['cache-control'] = 'no-store';
  if (isHtml) {
    headers['content-security-policy'] =
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'";
    headers['x-frame-options'] = 'DENY';
  }
  return headers;
}

export function securityState(cfg) {
  return {
    rateLimitPerMin: rateLimitPerMin(cfg),
    allowedIps: cfg?.security?.allowedIps ?? [],
  };
}

export function logRateLimited(ip, pathname) {
  logger.warn('rate limited', { ip, pathname });
}
