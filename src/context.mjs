// @body:organ=muscle type=context role="context windows + token estimate + truncate-oldest (summarize lives in routes; needs upstream call)"

export const FALLBACK_WINDOW = 8192;

// Conservative static defaults (tokens). Under-declaring is safe (compaction
// triggers earlier); overrides live in config `contextWindows`.
const STATIC_WINDOWS = {};

export function contextWindowOf(cfg, modelId) {
  const override = cfg?.contextWindows?.[modelId];
  if (Number.isInteger(override) && override >= 256) return override;
  return STATIC_WINDOWS[modelId] ?? FALLBACK_WINDOW;
}

export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages ?? []) {
    if (typeof m?.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) if (typeof part?.text === 'string') chars += part.text.length;
    }
  }
  return Math.ceil(chars / 4);
}

// Keep system messages + as many newest non-system turns as fit the budget.
// Never drops the last message (the current user turn). Pure truncate.
export function truncateOldest(messages, windowTokens) {
  const system = messages.filter((m) => m?.role === 'system');
  const nonSystem = messages.filter((m) => m?.role !== 'system');
  const systemTokens = estimateTokens(system);
  const budget = Math.max(64, windowTokens - systemTokens - 16);
  const keep = [];
  let used = 0;
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const t = estimateTokens([nonSystem[i]]);
    if (used + t > budget && keep.length > 0) break;
    keep.unshift(nonSystem[i]);
    used += t;
  }
  const dropped = nonSystem.length - keep.length;
  if (dropped === 0) return { messages, dropped: 0 };
  return { messages: [...system, ...keep], dropped };
}

// Split for summarize mode: newest turns that fit ~60% of the window stay
// verbatim; older non-system turns are handed to the summarizer.
export function splitForSummarize(messages, windowTokens) {
  const system = messages.filter((m) => m?.role === 'system');
  const nonSystem = messages.filter((m) => m?.role !== 'system');
  const keep = [];
  let used = 0;
  const budget = Math.max(64, Math.floor(windowTokens * 0.6));
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const t = estimateTokens([nonSystem[i]]);
    if (used + t > budget && keep.length > 0) break;
    keep.unshift(nonSystem[i]);
    used += t;
  }
  const dropped = nonSystem.slice(0, nonSystem.length - keep.length);
  return { system, keep, dropped };
}
