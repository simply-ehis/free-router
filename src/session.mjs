// @body:organ=immune type=security role="stateless dashboard sessions: password-derived HMAC tokens in an HttpOnly cookie (Workers-safe, no server store)"
import { safeEqual } from './util/http.mjs';

export const COOKIE_NAME = 'fr_session';
const enc = new TextEncoder();
const keyCache = new Map(); // secret -> CryptoKey (tiny: one entry per password/epoch)

const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const toB64Url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

// Compare passwords through a hash so neither length nor prefix leaks via timing.
export async function passwordMatches(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string' || !expected) return false;
  const [a, b] = await Promise.all([sha256Hex(input), sha256Hex(expected)]);
  return safeEqual(a, b);
}

// The signing secret changes when the password changes or when the owner
// presses "sign out everywhere" (security.sessionEpoch bump) — both kill every
// outstanding cookie without any server-side session list.
export function sessionSecret(cfg) {
  const password = cfg.dashboardPassword ?? cfg.apiKey ?? '';
  return `${password}\u0000${cfg.security?.sessionEpoch ?? 0}`;
}

async function signingKey(secret) {
  let key = keyCache.get(secret);
  if (!key) {
    const material = await crypto.subtle.digest('SHA-256', enc.encode(`free-router/session/v1\u0000${secret}`));
    key = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(secret, key);
  }
  return key;
}

async function sign(secret, payload) {
  return toB64Url(await crypto.subtle.sign('HMAC', await signingKey(secret), enc.encode(payload)));
}

export async function createSessionToken(secret, hours, now = Date.now()) {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(8)));
  const payload = `v1.${Math.floor(now / 1000) + Math.round(hours * 3600)}.${nonce}`;
  return `${payload}.${await sign(secret, payload)}`;
}

export async function verifySessionToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 256) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isInteger(exp) || exp * 1000 < now) return false;
  return safeEqual(await sign(secret, parts.slice(0, 3).join('.')), parts[3]);
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export function sessionCookie(token, { maxAgeSec, secure }) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export function clearedCookie({ secure }) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

// Cookie-authenticated writes must come from our own pages. SameSite=Strict
// already blocks cross-site sends; this is the belt to that pair of braces.
export function sameOriginRequest(request, url) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('origin');
  return !origin || origin === url.origin;
}
