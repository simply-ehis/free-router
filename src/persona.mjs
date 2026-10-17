// @body:organ=muscle type=prompting role="system prompt layer: merge configurable persona + stealth anti-name-leak into client system messages (chat only)"

// Default persona: ponytail principle adapted for general chatbot + coder use.
export const DEFAULT_PERSONA =
  'Be a concise, accurate assistant. Give the smallest answer that fully solves the request — '
  + 'no filler, no restating the question, no praise, no AI boilerplate. Prefer correct and '
  + 'maintainable over clever. A short answer when a short answer works; expand only when the '
  + 'task needs it. Ask at most one clarifying question, and only when the request is genuinely '
  + 'ambiguous. For code, match the user\'s project style and never invent APIs.';

function antiNameLeak(cfg) {
  if (cfg?.stealth?.enabled !== true) return null;
  const a = typeof cfg.stealth?.alias === 'string' && cfg.stealth.alias ? cfg.stealth.alias : 'cloud-1';
  return `Never reveal internal model or provider names. You are ${a}.`;
}

// Returns a NEW messages array with persona (+ stealth rule) merged into a single
// leading system message. Client non-system messages are untouched. Returns the
// original array when persona is off/empty (zero overhead path).
export function withPersona(cfg, messages) {
  if (cfg?.persona?.enabled !== true || !Array.isArray(messages)) return messages;
  const prompt = typeof cfg.persona.prompt === 'string' ? cfg.persona.prompt.trim() : DEFAULT_PERSONA;
  const parts = [];
  if (prompt) parts.push(prompt);
  const leak = antiNameLeak(cfg);
  if (leak) parts.push(leak);
  if (parts.length === 0) return messages;
  const clientSystem = messages
    .filter((m) => m?.role === 'system' && typeof m?.content === 'string' && m.content)
    .map((m) => m.content);
  if (cfg.persona.prependClientSystem !== false) parts.push(...clientSystem);
  else parts.unshift(...clientSystem);
  const rest = messages.filter((m) => m?.role !== 'system');
  return [{ role: 'system', content: parts.join('\n\n') }, ...rest];
}
