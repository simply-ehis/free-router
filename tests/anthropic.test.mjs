// @body:organ=muscle type=test role="Anthropic protocol request/response and streaming translation"
import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToOpenAI, openAIToAnthropic, anthropicStream } from '../src/anthropic.mjs';

test('Anthropic messages, system prompt, and tools map to OpenAI chat shape', () => {
  const body = anthropicToOpenAI({
    model: 'demo',
    max_tokens: 64,
    system: [{ type: 'text', text: 'Be helpful' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'found' }] },
    ],
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'lookup' },
  });
  assert.deepEqual(body.messages[0], { role: 'system', content: 'Be helpful' });
  assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,abc');
  assert.deepEqual(body.messages[2].tool_calls[0].function, { name: 'lookup', arguments: '{"q":"x"}' });
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'call-1', content: 'found' });
  assert.deepEqual(body.tools[0].function.parameters, { type: 'object' });
  assert.equal(body.tool_choice.function.name, 'lookup');
});

test('OpenAI completion maps to Anthropic message and usage fields', () => {
  const body = openAIToAnthropic({
    id: 'completion-1',
    model: 'demo',
    choices: [{ finish_reason: 'tool_calls', message: { content: 'done', tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"q":"x"}' } }] } }],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
  });
  assert.equal(body.type, 'message');
  assert.equal(body.stop_reason, 'tool_use');
  assert.deepEqual(body.usage, { input_tokens: 11, output_tokens: 3 });
  assert.deepEqual(body.content[1], { type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } });
});

test('OpenAI SSE is converted into Anthropic streaming events', async () => {
  const nl = String.fromCharCode(10);
  const frames = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: null }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]',
  ].join(nl + nl) + nl + nl;
  const upstream = new Response(frames).body;
  const output = await new Response(anthropicStream(upstream, 'demo')).text();
  assert.match(output, /event: message_start/);
  assert.match(output, /"text":"hello"/);
  assert.match(output, /"stop_reason":"end_turn"/);
  assert.match(output, /event: message_stop/);
});
