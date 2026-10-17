// @body:organ=face type=protocol role="Anthropic Messages API ? OpenAI chat protocol translation"
function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
}

function openAIContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = content.flatMap((part) => {
    if (part?.type === 'text') return [{ type: 'text', text: part.text ?? '' }];
    if (part?.type !== 'image' || !part.source) return [];
    const source = part.source;
    const url = source.type === 'base64'
      ? 'data:' + source.media_type + ';base64,' + source.data
      : source.url;
    return typeof url === 'string' ? [{ type: 'image_url', image_url: { url } }] : [];
  });
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

function convertMessage(message) {
  const content = Array.isArray(message.content) ? message.content : [];
  if (message.role === 'user' && content.some((part) => part?.type === 'tool_result')) {
    const out = [];
    let userParts = [];
    const flush = () => {
      if (userParts.length) out.push({ role: 'user', content: openAIContent(userParts) });
      userParts = [];
    };
    for (const part of content) {
      if (part?.type === 'tool_result') {
        flush();
        out.push({ role: 'tool', tool_call_id: part.tool_use_id, content: textContent(part.content) });
      } else userParts.push(part);
    }
    flush();
    return out;
  }
  const calls = content.filter((part) => part?.type === 'tool_use').map((part) => ({
    id: part.id,
    type: 'function',
    function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
  }));
  return [{
    role: message.role,
    content: message.role === 'assistant' ? textContent(message.content) : openAIContent(message.content),
    ...(calls.length ? { tool_calls: calls } : {}),
  }];
}

export function anthropicToOpenAI(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object');
  if (typeof body.model !== 'string' || !body.model) throw new Error('model is required');
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) throw new Error('max_tokens must be a positive integer');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error('messages must be a non-empty array');
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: textContent(body.system) });
  for (const message of body.messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) throw new Error('messages roles must be user or assistant');
    messages.push(...convertMessage(message));
  }
  const tools = Array.isArray(body.tools) ? body.tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema ?? { type: 'object' } },
  })) : undefined;
  let toolChoice;
  if (body.tool_choice?.type === 'tool') toolChoice = { type: 'function', function: { name: body.tool_choice.name } };
  else if (body.tool_choice?.type === 'any') toolChoice = 'required';
  else if (body.tool_choice?.type === 'none') toolChoice = 'none';
  else if (body.tool_choice?.type === 'auto') toolChoice = 'auto';
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(Array.isArray(body.stop_sequences) ? { stop: body.stop_sequences } : {}),
    ...(body.stream === true ? { stream: true } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

function stopReason(reason) {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  return 'end_turn';
}

export function openAIToAnthropic(completion, model) {
  const choice = completion?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
  for (const call of message.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments ?? '{}'); } catch { /* preserve valid JSON shape */ }
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
  }
  const usage = completion?.usage ?? {};
  return {
    id: completion?.id ?? 'msg_' + crypto.randomUUID(),
    type: 'message',
    role: 'assistant',
    model: model ?? completion?.model ?? '',
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 },
  };
}

function event(type, data) {
  return 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

export function anthropicStream(body, model) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const msgId = 'msg_' + crypto.randomUUID();
  let buffer = '';
  let started = false;
  let textOpen = false;
  let finished = false;
  let stop = 'end_turn';
  const tools = new Map();

  return new ReadableStream({
    async pull(controller) {
      const send = (type, data) => controller.enqueue(encoder.encode(event(type, data)));
      const start = () => {
        if (started) return;
        started = true;
        send('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      };
      const closeBlocks = () => {
        if (textOpen) { send('content_block_stop', { type: 'content_block_stop', index: 0 }); textOpen = false; }
        for (const tool of tools.values()) if (tool.open) { send('content_block_stop', { type: 'content_block_stop', index: tool.index }); tool.open = false; }
      };
      const finish = () => {
        if (finished) return;
        start();
        closeBlocks();
        send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 0 } });
        send('message_stop', { type: 'message_stop' });
        finished = true;
        controller.close();
      };
      const process = (raw) => {
        const data = raw.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!data) return;
        if (data === '[DONE]') { finish(); return; }
        let chunk;
        try { chunk = JSON.parse(data); } catch { return; }
        const choice = chunk.choices?.[0];
        if (!choice) return;
        start();
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          if (!textOpen) { send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); textOpen = true; }
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
        }
        for (const part of delta.tool_calls ?? []) {
          const idx = part.index ?? 0;
          let tool = tools.get(idx);
          if (!tool) {
            tool = { index: tools.size + 1, id: '', name: '', open: false };
            tools.set(idx, tool);
          }
          if (part.id) tool.id = part.id;
          if (part.function?.name) tool.name += part.function.name;
          if (!tool.open && tool.id && tool.name) {
            closeBlocks();
            send('content_block_start', { type: 'content_block_start', index: tool.index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
            tool.open = true;
          }
          if (tool.open && part.function?.arguments) send('content_block_delta', { type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: part.function.arguments } });
        }
        if (choice.finish_reason) stop = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
      };
      const processBufferedFrame = () => {
        const boundary = buffer.search(/\r?\n\r?\n/);
        if (boundary === -1) return false;
        const match = /\r?\n\r?\n/.exec(buffer.slice(boundary));
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + match[0].length);
        process(raw);
        return true;
      };
      try {
        if (processBufferedFrame()) return;
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (processBufferedFrame()) return;
          finish();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        processBufferedFrame();
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await reader.cancel();
    },
  });
}

export function anthropicError(message, type = 'api_error') {
  return { type: 'error', error: { type, message } };
}
