// @body:organ=immune type=security role="stealth: one public alias for /v1/models + response model-field rewrite + optional content scrub (Web-standard streams)"
import { logger } from './util/log.mjs';

export function isStealth(cfg) {
  return cfg?.stealth?.enabled === true;
}

export function alias(cfg) {
  return typeof cfg?.stealth?.alias === 'string' && cfg.stealth.alias ? cfg.stealth.alias : 'cloud-1';
}

// /v1/models body: alias-only when stealth, real list otherwise.
export function publicModelsBody(cfg, realModels) {
  if (!isStealth(cfg)) return { object: 'list', data: realModels };
  return {
    object: 'list',
    data: [{
      id: alias(cfg),
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'free-router',
    }],
  };
}

function scrubStrings(value, realIds, to) {
  if (typeof value === 'string') {
    let out = value;
    for (const id of realIds) {
      if (id && id !== to && out.includes(id)) out = out.split(id).join(to);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrubStrings(v, realIds, to));
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = scrubStrings(value[k], realIds, to);
    return value;
  }
  return value;
}

// Non-stream completion JSON: rewrite model field, optional content scrub.
// Mutates and returns the payload (it is a fresh parse owned by the caller).
export function rewriteCompletionJson(payload, cfg, realIds = []) {
  if (!isStealth(cfg) || payload === null || typeof payload !== 'object') return payload;
  if (typeof payload.model === 'string') payload.model = alias(cfg);
  if (cfg.stealth.scrubContent === true) scrubStrings(payload, realIds, alias(cfg));
  return payload;
}

function rewriteSseLine(line, cfg, realIds) {
  if (!line.startsWith('data:')) return line;
  const json = line.slice(5).trim();
  if (!json || json === '[DONE]') return line;
  let obj;
  try { obj = JSON.parse(json); } catch { return line; }
  if (obj === null || typeof obj !== 'object') return line;
  if (typeof obj.model === 'string') obj.model = alias(cfg);
  if (cfg.stealth.scrubContent === true) scrubStrings(obj, realIds, alias(cfg));
  return `data: ${JSON.stringify(obj)}\n`;
}

// Line-wise SSE transformer (Web TransformStream): buffers only up to the next
// newline (never the whole content), swaps the model field per data-line.
const MAX_LINE = 4_000_000;

export function sseModelRewriterStream(cfg, realIds = []) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = '';
  const flushLine = (line) => rewriteSseLine(line, cfg, realIds);
  return new TransformStream({
    transform(chunk, controller) {
      buf += dec.decode(chunk, { stream: true });
      if (buf.length > MAX_LINE) {
        controller.enqueue(enc.encode(buf));
        buf = '';
        return;
      }
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const p of parts) controller.enqueue(enc.encode(flushLine(p + '\n')));
    },
    flush(controller) {
      const tail = dec.decode();
      if (tail) buf += tail;
      if (buf) controller.enqueue(enc.encode(flushLine(buf)));
    },
  });
}

export function logStealthActive(cfg) {
  if (isStealth(cfg)) logger.info('stealth active', { alias: alias(cfg) });
}
