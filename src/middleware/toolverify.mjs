// @body:organ=immunity type=middleware role="tool-call verification gate (off|flag|block) — non-stream only, fail-open"
import { decide } from '../decision.mjs';

const CONFIDENT_YES = 0.5;

// Verifies that tool calls in an assembled non-stream response are justified by
// the conversation. Returns:
//   {action: 'allow'}                        — no tool calls, mode off, or plane unavailable (fail-open)
//   {action: 'allow', prob}                  — Jev confident the calls are justified
//   {action: 'flag',  prob}                  — suspect, response rides with a marker
//   {action: 'block', prob}                  — suspect and mode === 'block'
export async function checkToolCalls(cfg, body, assembled) {
  const mode = cfg?.decision?.toolVerify ?? 'off';
  if (mode === 'off') return { action: 'allow' };
  const toolCalls = assembled?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return { action: 'allow' };

  const state = {
    messages: (Array.isArray(body?.messages) ? body.messages : []).map((m) => ({
      role: m?.role ?? 'user',
      content: typeof m?.content === 'string' ? m.content.slice(0, 2000) : '[non-text]',
    })),
    tool_calls: toolCalls.map((t) => ({
      name: t?.function?.name ?? '?',
      arguments: String(t?.function?.arguments ?? '').slice(0, 1500),
    })),
  };
  const out = await decide(cfg, state, {
    justified: {
      type: 'noul',
      instructions: 'Are these tool calls justified by the conversation context?',
    },
  }, { purpose: 'tool-verify' });

  const prob = out?.answers?.justified?.noul;
  if (typeof prob !== 'number') return { action: 'allow' }; // fail-open
  if (prob >= CONFIDENT_YES) return { action: 'allow', prob };
  return { action: mode === 'block' ? 'block' : 'flag', prob };
}
