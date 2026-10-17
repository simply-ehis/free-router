// @body:organ=face type=dashboard role="playground chat: dashboard-authenticated conversation through the router engine — auto or pinned model, system prompt, streaming SSE relay, usage attributed to the playground label"
import { runChat } from './routes.mjs';
import { jsonRes, errRes } from './util/http.mjs';

// Unknown ids fall through resolveRequested: "auto" → pure strategy order
// (or the configured defaultModel, if one is set).
const AUTO_MODEL = 'auto';
const MAX_MESSAGES = 200;
const MAX_TOKENS_CAP = 32768;
const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function validMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return null;
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object' || !VALID_ROLES.has(m.role) || typeof m.content !== 'string') return null;
    clean.push({ role: m.role, content: m.content });
  }
  return clean;
}

function toChatBody(body, messages) {
  const chatBody = {
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : AUTO_MODEL,
    messages,
    stream: body.stream === true,
  };
  if (typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2) chatBody.temperature = body.temperature;
  if (Number.isInteger(body.maxTokens) && body.maxTokens > 0 && body.maxTokens <= MAX_TOKENS_CAP) chatBody.max_tokens = body.maxTokens;
  return chatBody;
}

export async function playgroundChat(body, cfg) {
  const messages = validMessages(body?.messages);
  if (!messages) return errRes(400, '`messages` must be a non-empty array of string-content messages', 'invalid_messages');
  const chatBody = toChatBody(body, messages);
  const out = await runChat(cfg, chatBody, { keyId: 'playground', keyLabel: 'playground' });

  if (out.streaming) {
    // Raw engine SSE relay to the operator console — stealth scrubs client
    // traffic, not the dashboard, so real model ids ride in headers + chunks.
    return new Response(out.upstream.body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-router-model': encodeURIComponent(out.route?.model ?? chatBody.model),
        'x-router-provider': encodeURIComponent(out.route?.provider ?? ''),
        'x-router-attempts': String(out.attempts?.length ?? 1),
      },
    });
  }
  if (out.status !== 200) {
    let message = 'Playground request failed';
    try { message = JSON.parse(out.text)?.error?.message ?? message; } catch { /* keep default */ }
    return jsonRes(out.status, { error: { message, type: 'playground_error', attempts: out.attempts ?? [] } });
  }
  let payload = null;
  try { payload = JSON.parse(out.text); } catch { return errRes(502, 'Upstream returned an invalid completion', 'bad_upstream'); }
  const message = payload?.choices?.[0]?.message ?? {};
  return jsonRes(200, {
    reply: typeof message.content === 'string' ? message.content : '',
    model: out.route?.model ?? chatBody.model,
    provider: out.route?.provider ?? '',
    ms: out.attempts?.at(-1)?.ms ?? 0,
    attempts: out.attempts?.length ?? 1,
    tokensIn: Number(payload?.usage?.prompt_tokens) || null,
    tokensOut: Number(payload?.usage?.completion_tokens) || null,
    compacted: out.compaction ? { mode: out.compaction.mode, dropped: out.compaction.dropped } : null,
  });
}
