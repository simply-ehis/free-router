// @body:organ=face role="HTTP surface: /healthz, dashboard UI+API, /v1/models, /v1/chat/completions, /v1/decide (Web-standard core + node adapter)"
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logger } from './util/log.mjs';
import { getChatModels } from './catalog.mjs';
import { runChat } from './routes.mjs';
import { decide } from './decision.mjs';
import { handleDashboard } from './dashboard.mjs';
import { serveDashboardHtml, serveDashboardAsset } from './dashboardAssets.mjs';
import { consumeRate, ipAllowed, remoteIp, securityHeaders, logRateLimited } from './security.mjs';
import { isStealth, publicModelsBody, rewriteCompletionJson, sseModelRewriterStream } from './stealth.mjs';
import { jsonRes, errRes, readBodyText, safeEqual } from './util/http.mjs';
import { anthropicToOpenAI, openAIToAnthropic, anthropicStream, anthropicError } from './anthropic.mjs';
import { findApiKey } from './apiKeys.mjs';

function clientKey(request) {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : request.headers.get('x-api-key') ?? '';
}

function handleModels(cfg, anthropic = false) {
  const models = getChatModels();
  if (anthropic) {
    const data = models.map((m) => ({
      type: 'model',
      id: m.id,
      display_name: m.id,
      created_at: new Date(0).toISOString(),
      allowed_fallback_models: null,
      capabilities: null,
      deprecated_at: null,
      lifecycle: 'active',
      line: null,
      max_input_tokens: null,
      max_tokens: null,
      retires_at: null,
    }));
    const visible = publicModelsBody(cfg, data);
    const rows = (visible.data ?? []).map((m) => ({
      ...m,
      type: 'model',
      display_name: m.display_name ?? m.id,
      created_at: m.created_at ?? new Date(0).toISOString(),
      allowed_fallback_models: null,
      capabilities: null,
      deprecated_at: null,
      lifecycle: 'active',
      line: null,
      max_input_tokens: null,
      max_tokens: null,
      retires_at: null,
    }));
    return jsonRes(200, {
      data: rows,
      first_id: rows[0]?.id ?? null,
      last_id: rows.at(-1)?.id ?? null,
      has_more: false,
    });
  }
  const data = models.map((m) => ({
    id: m.id,
    object: 'model',
    created: Math.floor(m.addedAt / 1000),
    owned_by: `free-router/${m.provider}`,
  }));
  return jsonRes(200, publicModelsBody(cfg, data));
}

async function handleChat(request, cfg, keyMeta) {
  let raw;
  try {
    raw = await readBodyText(request);
  } catch (err) {
    return errRes(err.status ?? 413, 'Request body too large');
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return errRes(400, 'Invalid JSON body');
  }
  const out = await runChat(cfg, body, keyMeta);
  const stealth = isStealth(cfg);
  const realIds = stealth ? [...getChatModels().map((m) => m.id), out.route?.model].filter(Boolean) : [];
  if (out.streaming) {
    // Failover already happened before this first byte — relay is immutable.
    const headers = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...securityHeaders({ isApi: true }),
    };
    if (out.compaction) {
      headers['x-router-compacted'] = JSON.stringify({ compacted: true, mode: out.compaction.mode, dropped: out.compaction.dropped });
    }
    const bodyStream = stealth
      ? out.upstream.body.pipeThrough(sseModelRewriterStream(cfg, realIds))
      : out.upstream.body;
    return new Response(bodyStream, { status: 200, headers });
  }
  const payload = rewriteCompletionJson(JSON.parse(out.text), cfg, realIds);
  return jsonRes(out.status, payload);
}

function validateDecide(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const { state, questions } = body;
  if (typeof state !== 'string' && typeof state !== 'object') return '`state` must be a string or object';
  if (questions === null || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
    return '`questions` must be a non-empty object map';
  }
  for (const [name, spec] of Object.entries(questions)) {
    if (spec === null || typeof spec !== 'object' || !['noul', 'choice', 'score'].includes(spec.type)) {
      return `questions.${name}.type must be noul, choice, or score`;
    }
  }
  return null;
}

async function handleAnthropicMessages(request, cfg, keyMeta) {
  let raw;
  try { raw = await readBodyText(request); } catch (err) {
    return jsonRes(err.status ?? 413, anthropicError('Request body too large', 'invalid_request_error'));
  }
  let body;
  try { body = JSON.parse(raw); } catch {
    return jsonRes(400, anthropicError('Invalid JSON body', 'invalid_request_error'));
  }
  let chatBody;
  try { chatBody = anthropicToOpenAI(body); } catch (err) {
    return jsonRes(400, anthropicError(err.message, 'invalid_request_error'));
  }
  const out = await runChat(cfg, chatBody, keyMeta);
  if (out.streaming) {
    const stream = anthropicStream(out.upstream.body, out.route?.model ?? body.model);
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no', 'anthropic-version': '2023-06-01' },
    });
  }
  if (out.status !== 200) {
    let message = 'No available model';
    try { message = JSON.parse(out.text)?.error?.message ?? message; } catch { /* keep safe message */ }
    return jsonRes(out.status, anthropicError(message, out.status < 500 ? 'invalid_request_error' : 'api_error'));
  }
  try {
    const completion = JSON.parse(out.text);
    return jsonRes(200, openAIToAnthropic(completion, out.route?.model));
  } catch {
    return jsonRes(502, anthropicError('Upstream returned an invalid completion', 'api_error'));
  }
}

async function handleDecide(request, cfg) {
  let raw;
  try {
    raw = await readBodyText(request);
  } catch (err) {
    return errRes(err.status ?? 413, 'Request body too large');
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return errRes(400, 'Invalid JSON body');
  }
  const invalid = validateDecide(body);
  if (invalid) return errRes(400, invalid);
  const out = await decide(cfg, body.state, body.questions, { purpose: 'client', timeoutMs: 1500 });
  if (!out) {
    return errRes(502, 'Decision plane unavailable', 'server_error', { 'x-router-error-code': 'decision_unavailable' });
  }
  return jsonRes(200, { model: out.model, answers: out.answers, usage: out.usage ?? null });
}

// Web-standard entry: Request in, Response out. This is what the Workers
// entrypoint calls; the node adapter below is a thin bridge.
export async function handleRequest(request, cfg) {
  const url = new URL(request.url);
  const isHtml = url.pathname === '/' || url.pathname === '/dashboard';
  const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/');
  const baseHeaders = securityHeaders({ isApi: isApi && !isHtml, isHtml, secure: url.protocol === 'https:' });
  if (!ipAllowed(cfg, remoteIp(request))) {
    return errRes(403, 'IP not allowed', 'invalid_request_error', baseHeaders);
  }
  // Rate limit: all /v1/* plus mutating /api/* (dashboard reads + SSE exempt).
  const mutating = request.method !== 'GET' && request.method !== 'HEAD';
  if (url.pathname.startsWith('/v1/') || (url.pathname.startsWith('/api/') && mutating)) {
    const rate = consumeRate(cfg, remoteIp(request));
    if (!rate.allowed) {
      logRateLimited(remoteIp(request), url.pathname);
      return errRes(429, 'Rate limit exceeded', 'rate_limit_error', { ...baseHeaders, 'retry-after': String(rate.retryAfterSec) });
    }
  }
  if (url.pathname === '/healthz') return jsonRes(200, { status: 'ok' }, baseHeaders);
  if (url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...baseHeaders } });
  }
  if (url.pathname === '/favicon.ico') {
    return new Response(null, { status: 204, headers: { 'cache-control': 'public, max-age=86400' } });
  }
  // Dashboard css/js assets — public, no auth (the data behind them all requires the dashboard password).
  if (request.method === 'GET' || request.method === 'HEAD') {
    const asset = serveDashboardAsset(url.pathname);
    if (asset) {
      for (const [k, v] of Object.entries(baseHeaders)) asset.headers.set(k, v);
      return asset;
    }
  }
  if (isHtml) {
    const res = serveDashboardHtml();
    for (const [k, v] of Object.entries(baseHeaders)) res.headers.set(k, v);
    return res;
  }
  if (url.pathname.startsWith('/api/')) {
    const res = await handleDashboard(request, cfg, url);
    for (const [k, v] of Object.entries(baseHeaders)) if (!res.headers.has(k)) res.headers.set(k, v);
    return res;
  }
  const presentedKey = clientKey(request);
  const matched = cfg.apiKeys === undefined ? null : await findApiKey(presentedKey, cfg.apiKeys);
  const authorized = cfg.apiKeys === undefined ? safeEqual(presentedKey, cfg.apiKey) : matched !== null;
  if (!authorized) return errRes(401, 'Invalid API key', 'invalid_request_error', baseHeaders);
  // Attribution for the usage ledger — never the key value itself.
  const keyMeta = { keyId: matched?.id ?? 'gateway', keyLabel: matched?.label ?? 'gateway' };
  if (url.pathname === '/v1/models' && request.method === 'GET') {
    const res = handleModels(cfg, request.headers.has('anthropic-version'));
    for (const [k, v] of Object.entries(baseHeaders)) res.headers.set(k, v);
    return res;
  }
  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    const res = await handleChat(request, cfg, keyMeta);
    for (const [k, v] of Object.entries(baseHeaders)) if (!res.headers.has(k)) res.headers.set(k, v);
    return res;
  }
  if (url.pathname === '/v1/messages' && request.method === 'POST') {
    const res = await handleAnthropicMessages(request, cfg, keyMeta);
    for (const [k, v] of Object.entries(baseHeaders)) if (!res.headers.has(k)) res.headers.set(k, v);
    return res;
  }
  if (url.pathname === '/v1/decide' && request.method === 'POST' && cfg.decision?.enabled === true && cfg.decision.expose === true) {
    const res = await handleDecide(request, cfg);
    for (const [k, v] of Object.entries(baseHeaders)) res.headers.set(k, v);
    return res;
  }
  return errRes(404, `Unknown route: ${request.method} ${url.pathname}`, 'invalid_request_error', baseHeaders);
}

// node:http → Web Request bridge. Strips client-supplied proxy headers and
// always sets x-local-ip from the socket so remoteIp() cannot be spoofed.
function nodeToRequest(req) {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (lower === 'cf-connecting-ip' || lower === 'x-real-ip' || lower === 'x-forwarded-for' || lower === 'x-local-ip') continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, v);
  }
  headers.set('x-local-ip', req.socket?.remoteAddress ?? 'local');
  const method = req.method ?? 'GET';
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function sendResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(response.status, headers);
  if (response.body) {
    await pipeline(Readable.fromWeb(response.body), res);
  } else {
    res.end();
  }
}

export function startServer(cfg) {
  const server = http.createServer((req, res) => {
    handleRequest(nodeToRequest(req), cfg)
      .then((response) => sendResponse(res, response))
      .catch((err) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        // A browser closing a stream (tab closed, EventSource reconnect) is routine, not a crash.
        const hangup = err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || err?.message === 'Premature close' || err?.code === 'ECONNRESET';
        if (hangup && res.headersSent) logger.debug?.('client closed the stream', { pathname });
        else logger.error('request handler crashed', { error: err.message, pathname });
        if (!res.headersSent) {
          const body = JSON.stringify({ error: { message: 'Internal router error', type: 'server_error' } });
          res.writeHead(500, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
          res.end(body);
        } else {
          res.destroy();
        }
      });
  });
  server.listen(cfg.port, cfg.host, () => {
    logger.info('free-router listening', { url: `http://${cfg.host}:${cfg.port}` });
  });
  server.on('error', (err) => {
    logger.error('server failed to start', { error: err.message, host: cfg.host, port: cfg.port });
    process.exit(1);
  });
  return server;
}
