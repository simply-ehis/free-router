// @body:organ=muscle type=util role="SSE (re)assembly: upstream chat.completion.chunk stream → non-stream JSON"
import { logger } from './log.mjs';

// Zen free tier only answers stream:true (gatekeeper), so non-stream gateway
// clients get the SSE buffered and assembled back into one chat.completion.
export function assembleChatCompletion(sseText, { stripToolNames = new Set() } = {}) {
  let id = null;
  let created = null;
  let model = null;
  let finishReason = 'stop';
  let role = 'assistant';
  let content = '';
  let reasoning = '';
  const toolCalls = new Map(); // index -> {id, type, name, arguments}
  let usage = null;

  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    id ??= chunk.id ?? null;
    created ??= chunk.created ?? null;
    model ??= chunk.model ?? null;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (delta.role) role = delta.role;
    if (delta.content) content += delta.content;
    if (delta.reasoning) reasoning += delta.reasoning;
    for (const tc of delta.tool_calls ?? []) {
      const key = tc.index ?? 0;
      const entry = toolCalls.get(key) ?? { id: null, type: 'function', name: '', arguments: '' };
      if (tc.id) entry.id = tc.id;
      if (tc.type) entry.type = tc.type;
      if (tc.function?.name) entry.name += tc.function.name;
      if (tc.function?.arguments) entry.arguments += tc.function.arguments;
      toolCalls.set(key, entry);
    }
  }

  let stripped = [];
  const keptToolCalls = [];
  for (const entry of toolCalls.values()) {
    if (stripToolNames.has(entry.name)) stripped.push(entry.name);
    else keptToolCalls.push({ id: entry.id ?? `call_${keptToolCalls.length}`, type: entry.type, function: { name: entry.name, arguments: entry.arguments } });
  }

  const message = { role, content };
  if (reasoning) message.reasoning_content = reasoning;
  if (stripped.length > 0) {
    const note = `[gateway: tool${stripped.length > 1 ? 's' : ''} ${stripped.join(', ')} unavailable here — use your other tools]`;
    message.content = message.content ? `${message.content}\n\n${note}` : note;
    finishReason = 'stop';
    logger.warn('injected gate tool called by model — stripped', { tools: stripped });
  }
  if (keptToolCalls.length > 0) message.tool_calls = keptToolCalls;
  if (finishReason === 'tool_calls' && !message.tool_calls) finishReason = 'stop';

  return {
    id: id ?? `chatcmpl-fr-${Date.now()}`,
    object: 'chat.completion',
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? 'unknown',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

export function looksLikeSSE(contentType, text) {
  return (contentType ?? '').includes('text/event-stream') || text.startsWith('data:');
}
