// @body:organ=muscle type=test role="SSE assembly: content, usage, tool-call aggregation, injected-tool strip"
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleChatCompletion, looksLikeSSE } from '../src/util/sse.mjs';

const line = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test('assembles content, role, usage and model across chunks', () => {
  const sse =
    line({ id: 'c1', created: 7, model: 'm1', choices: [{ index: 0, delta: { role: 'assistant' } }] }) +
    line({ id: 'c1', model: 'm1', choices: [{ index: 0, delta: { content: 'Hel' } }] }) +
    line({ id: 'c1', model: 'm1', choices: [{ index: 0, delta: { content: 'lo' } }] }) +
    line({ id: 'c1', model: 'm1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) +
    'data: [DONE]\n\n';
  const out = assembleChatCompletion(sse);
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.choices[0].message.content, 'Hello');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.equal(out.usage.total_tokens, 5);
  assert.equal(out.model, 'm1');
});

test('aggregates split tool_call arguments and keeps client tools', () => {
  const sse =
    line({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'execute_command', arguments: '{"cmd":' } }] } }] }) +
    line({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] }) +
    line({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  const out = assembleChatCompletion(sse, { stripToolNames: new Set(['shell', 'read']) });
  assert.equal(out.choices[0].message.tool_calls.length, 1);
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'execute_command');
  assert.equal(out.choices[0].message.tool_calls[0].function.arguments, '{"cmd":"ls"}');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
});

test('strips injected gate tool_calls and leaves an explanatory note', () => {
  const sse =
    line({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_s', function: { name: 'shell', arguments: '{}' } }] } }] }) +
    line({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  const out = assembleChatCompletion(sse, { stripToolNames: new Set(['shell', 'read']) });
  assert.equal(out.choices[0].message.tool_calls, undefined);
  assert.match(out.choices[0].message.content, /shell.*unavailable/);
  assert.equal(out.choices[0].finish_reason, 'stop');
});

test('reasoning deltas become reasoning_content', () => {
  const sse =
    line({ choices: [{ index: 0, delta: { reasoning: 'think ' } }] }) +
    line({ choices: [{ index: 0, delta: { reasoning: 'more' } }] }) +
    line({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] });
  const out = assembleChatCompletion(sse);
  assert.equal(out.choices[0].message.reasoning_content, 'think more');
  assert.equal(out.choices[0].message.content, 'ok');
});

test('looksLikeSSE detects content-type and bare data prefix', () => {
  assert.equal(looksLikeSSE('text/event-stream; charset=utf-8', '{}'), true);
  assert.equal(looksLikeSSE('application/json', 'data: {}'), true);
  assert.equal(looksLikeSSE('application/json', '{"id":1}'), false);
});
