// @body:organ=muscle type=util role="shared /models fetch for provider adapters: keeps each raw model object so the catalog can classify by modality metadata"

// Returns [{ id, meta }] — meta is the provider's raw model object (modalities,
// capabilities, methods...). It is read by classifyModel and never stored.
export async function listJsonModels(url, { headers = {}, signal, timeoutMs = 30_000, label = 'provider', pick = (json) => json?.data } = {}) {
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(timeoutMs), headers });
  if (!res.ok) throw new Error(`${label} listModels HTTP ${res.status}`);
  const json = await res.json();
  const rows = pick(json);
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(rows) ? rows : []) {
    if (typeof m?.id !== 'string' || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, meta: m });
  }
  return out;
}
