// @body:organ=immune type=test role="dashboard auth: session cookie, lockout, same-origin guard, strict CSP, no query-string passwords"
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-auth-'));
process.env.FREE_ROUTER_CONFIG = path.join(tmp, 'config.json');

const { handleRequest } = await import('../src/server.mjs');
const { resetRateLimiter } = await import('../src/security.mjs');
const { resetAuthGuard } = await import('../src/authGuard.mjs');
const { createSessionToken, verifySessionToken, sessionSecret, passwordMatches } = await import('../src/session.mjs');

const PASSWORD = 'correct-horse-battery-staple-123';

function cfg(over = {}) {
  return {
    name: 'Cloud', dashboardPassword: PASSWORD, apiKeys: [], host: '127.0.0.1', port: 4141, autoDiscover: false,
    selection: { strategy: 'sticky', pool: 'all', weights: { success: 0.4, latency: 0.3, freshness: 0.2, priority: 0.1 }, timeboxMs: 80, attemptTimeoutMs: 5000, forceChat: [] },
    providers: { zen: { enabled: false, importOpencodeAuth: false, keys: [], baseUrl: '' } },
    probe: { intervalMs: 600000, standbyWarm: 0 },
    refresh: { catalogMinutes: 10 },
    security: { rateLimitPerMin: 0, allowedIps: [], sessionHours: 12, maxLoginFailures: 3 },
    decision: { enabled: false, model: 'jev-1.13-free', classify: false, diagnose: false, rankHints: false, toolVerify: 'off', expose: false },
    ...over,
  };
}

function req(pathname, { method = 'GET', headers = {}, body, ip = '203.0.113.7', https = false } = {}) {
  const h = { 'x-local-ip': ip, ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  return new Request(`${https ? 'https' : 'http'}://router.local${pathname}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

const login = (password, extra = {}) => handleRequest(req('/api/login', { method: 'POST', body: { password }, ...extra }), cfg());
const cookieOf = (res) => (res.headers.get('set-cookie') ?? '').split(';')[0];

test.beforeEach(() => { resetAuthGuard(); resetRateLimiter(); });

test('login: right password sets an HttpOnly SameSite=Strict cookie that authenticates the API', async () => {
  const res = await login(PASSWORD, { https: true });
  assert.equal(res.status, 200);
  const raw = res.headers.get('set-cookie');
  assert.match(raw, /fr_session=v1\./);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.match(raw, /Secure/, 'Secure on https');
  assert.doesNotMatch(raw, new RegExp(PASSWORD), 'password never appears in the cookie');
  const status = await handleRequest(req('/api/status', { headers: { cookie: cookieOf(res) } }), cfg());
  assert.equal(status.status, 200);
});

test('login: wrong password is 401, no cookie', async () => {
  const res = await login('nope-nope-nope');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('lockout: repeated wrong passwords lock the IP (429 + retry-after) even for the right password', async () => {
  for (let i = 0; i < 2; i += 1) assert.equal((await login(`bad-${i}-password`)).status, 401);
  const third = await login('bad-2-password');
  assert.equal(third.status, 429, 'third failure trips the lock (maxLoginFailures=3)');
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
  assert.equal((await login(PASSWORD)).status, 429, 'locked IP cannot keep guessing');
  const other = await login(PASSWORD, { ip: '198.51.100.9' });
  assert.equal(other.status, 200, 'other IPs are unaffected');
});

test('lockout also covers the Authorization-header path used by scripts', async () => {
  for (let i = 0; i < 3; i += 1) await handleRequest(req('/api/status', { headers: { authorization: `Bearer wrong-${i}-password` } }), cfg());
  const res = await handleRequest(req('/api/status', { headers: { authorization: `Bearer ${PASSWORD}` } }), cfg());
  assert.equal(res.status, 429);
});

test('a successful login resets the failure counter', async () => {
  await login('bad-a-password');
  await login('bad-b-password');
  assert.equal((await login(PASSWORD)).status, 200);
  assert.equal((await login('bad-c-password')).status, 401);
  assert.equal((await login('bad-d-password')).status, 401);
});

test('cookie-authenticated writes from another origin are blocked; same-origin and bearer pass', async () => {
  const cookie = cookieOf(await login(PASSWORD));
  const body = { name: 'Renamed' };
  const cross = await handleRequest(req('/api/config', { method: 'PUT', body, headers: { cookie, origin: 'https://evil.example' } }), cfg());
  assert.equal(cross.status, 403);
  const siteHeader = await handleRequest(req('/api/config', { method: 'PUT', body, headers: { cookie, 'sec-fetch-site': 'cross-site' } }), cfg());
  assert.equal(siteHeader.status, 403);
  const bearer = await handleRequest(req('/api/config', { method: 'PUT', body, headers: { authorization: `Bearer ${PASSWORD}`, origin: 'https://evil.example' } }), cfg());
  assert.notEqual(bearer.status, 403, 'bearer auth is not CSRF-able, so the origin guard does not apply');
});

test('tokens: tampered, expired, and wrong-password/epoch tokens are rejected', async () => {
  const c = cfg();
  const secret = sessionSecret(c);
  const token = await createSessionToken(secret, 1);
  assert.equal(await verifySessionToken(token, secret), true);
  assert.equal(await verifySessionToken(`${token}x`, secret), false);
  assert.equal(await verifySessionToken(token.replace('v1.', 'v1.9'), secret), false);
  assert.equal(await verifySessionToken(await createSessionToken(secret, 1, Date.now() - 7_200_000), secret), false, 'expired');
  assert.equal(await verifySessionToken(token, sessionSecret({ ...c, dashboardPassword: 'a-different-password' })), false);
  assert.equal(await verifySessionToken(token, sessionSecret({ ...c, security: { ...c.security, sessionEpoch: 1 } })), false, 'sign-out-everywhere bumps the epoch');
});

test('passwordMatches is exact and hides length', async () => {
  assert.equal(await passwordMatches(PASSWORD, PASSWORD), true);
  assert.equal(await passwordMatches(PASSWORD.slice(0, -1), PASSWORD), false);
  assert.equal(await passwordMatches('', PASSWORD), false);
  assert.equal(await passwordMatches(PASSWORD, ''), false);
});

test('logout clears the cookie', async () => {
  const res = await handleRequest(req('/api/logout', { method: 'POST' }), cfg());
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
});

test('HTML: strict CSP (no inline script), framing denied, no-store, noindex; robots.txt disallows all', async () => {
  const res = await handleRequest(req('/', { https: true }), cfg());
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp.split('style-src')[0], /unsafe-inline/, 'script-src has no unsafe-inline');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.match(res.headers.get('strict-transport-security'), /max-age=/);
  const plain = await handleRequest(req('/'), cfg());
  assert.equal(plain.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
  const robots = await handleRequest(req('/robots.txt'), cfg());
  assert.match(await robots.text(), /Disallow: \//);
});

test('the dashboard page ships no inline scripts or inline event handlers', async () => {
  const html = await (await handleRequest(req('/'), cfg())).text();
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, 'only external <script src>');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no onclick/onsubmit attributes');
});
