// @body:organ=muscle type=util role="Web-standard HTTP helpers: JSON responses, constant-time auth compare, size-capped body read"

export function jsonRes(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errRes(status, message, type = 'invalid_request_error', headers = {}) {
  return jsonRes(status, { error: { message, type } }, headers);
}

// Constant-time string compare (no node:crypto — portable to Workers).
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function readBodyText(request, maxBytes = 10 * 1024 * 1024) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      const err = new Error('body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}
