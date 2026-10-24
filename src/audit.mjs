// @body:organ=immune type=audit role="append-only dashboard audit trail (never secrets) + capped newest-first tail"
import path from 'node:path';
import { ROOT } from './config.mjs';
import { store } from './store.mjs';
import { logger } from './util/log.mjs';

export const AUDIT_PATH = path.join(ROOT, 'logs', 'audit.jsonl');

export function audit(action, detail = {}) {
  try {
    store.append(AUDIT_PATH, `${JSON.stringify({ at: new Date().toISOString(), action, ...detail })}\n`);
  } catch (err) {
    logger.warn('audit write failed', { error: err.message, action });
  }
}

// Newest-first tail of the audit log; the read is capped so a huge file can
// never stall a dashboard request.
export function auditTail(limit = 200) {
  const raw = (store.read(AUDIT_PATH) ?? '').slice(-131_072);
  const entries = [];
  for (const line of raw.split('\n').filter(Boolean).slice(-limit).reverse()) {
    try { entries.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return entries;
}

// Failed sign-ins can arrive in floods; keep the trail readable by logging at
// most one failure per IP per 30 seconds.
const lastFailLogged = new Map();
export function auditAuthFailure(ip, detail = {}) {
  const now = Date.now();
  if (now - (lastFailLogged.get(ip) ?? 0) < 30_000) return;
  if (lastFailLogged.size > 500) lastFailLogged.clear();
  lastFailLogged.set(ip, now);
  audit('auth.fail', { ip, ...detail });
}
