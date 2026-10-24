// @body:organ=immune type=security role="dashboard authentication: session cookie or password bearer, login/logout, lockout, same-origin guard for cookie writes"
import { passwordMatches, sessionSecret, createSessionToken, verifySessionToken, readCookie, sessionCookie, clearedCookie, sameOriginRequest, COOKIE_NAME } from './session.mjs';
import { lockState, noteFailure, noteSuccess } from './authGuard.mjs';
import { remoteIp } from './security.mjs';
import { audit, auditAuthFailure } from './audit.mjs';
import { jsonRes, errRes, readBodyText } from './util/http.mjs';

const isSecure = (url) => url.protocol === 'https:';
const sessionHours = (cfg) => cfg.security?.sessionHours ?? 12;
const expectedPassword = (cfg) => cfg.dashboardPassword ?? cfg.apiKey;

function lockedResponse(retryAfterSec) {
  return errRes(429, 'Too many failed sign-ins — try again later', 'rate_limit_error', { 'retry-after': String(retryAfterSec) });
}

// Verifies one password attempt with lockout accounting. Returns null on
// success, or the Response to send.
async function checkPassword(cfg, request, attempt) {
  const ip = remoteIp(request);
  const lock = lockState(ip);
  if (lock.locked) return lockedResponse(lock.retryAfterSec);
  if (await passwordMatches(attempt, expectedPassword(cfg))) {
    noteSuccess(ip);
    return null;
  }
  const after = noteFailure(cfg, ip);
  auditAuthFailure(ip, { locked: after.locked });
  return after.locked ? lockedResponse(after.retryAfterSec) : errRes(401, 'Invalid dashboard password');
}

export async function handleLogin(request, cfg, url) {
  if (!sameOriginRequest(request, url)) return errRes(403, 'Cross-site request blocked');
  let body;
  try { body = JSON.parse(await readBodyText(request, 4096) || '{}'); } catch { return errRes(400, 'Invalid JSON body'); }
  const denied = await checkPassword(cfg, request, typeof body?.password === 'string' ? body.password : '');
  if (denied) return denied;
  const hours = sessionHours(cfg);
  const token = await createSessionToken(sessionSecret(cfg), hours);
  audit('auth.login', { ip: remoteIp(request) });
  return jsonRes(200, { ok: true, expiresInSec: hours * 3600 }, { 'set-cookie': sessionCookie(token, { maxAgeSec: hours * 3600, secure: isSecure(url) }) });
}

// "Am I signed in?" without a 401 (so the login screen does not log a console
// error) and without touching the lockout counters: only a cookie is checked.
export async function handleSessionProbe(request, cfg) {
  const cookie = readCookie(request, COOKIE_NAME);
  return jsonRes(200, { authenticated: Boolean(cookie) && await verifySessionToken(cookie, sessionSecret(cfg)) });
}

export function handleLogout(url) {
  return jsonRes(200, { ok: true }, { 'set-cookie': clearedCookie({ secure: isSecure(url) }) });
}

// → { ok: true, via } or { ok: false, response }.
// A valid session cookie wins. Otherwise a password in Authorization (scripts,
// curl) is accepted but goes through the same lockout as the login form.
export async function authenticate(request, cfg) {
  const cookie = readCookie(request, COOKIE_NAME);
  if (cookie && await verifySessionToken(cookie, sessionSecret(cfg))) return { ok: true, via: 'cookie' };
  const header = request.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : request.headers.get('x-api-key') ?? '';
  if (!bearer) return { ok: false, response: errRes(401, 'Sign in required') };
  const denied = await checkPassword(cfg, request, bearer);
  return denied ? { ok: false, response: denied } : { ok: true, via: 'bearer' };
}

export { sameOriginRequest };
