// @body:organ=muscle type=catalog role="what each provider's free lane is and how much background checking it can afford (limits quoted from the provider adapters' own notes)"

// keyless: serves free models with no account. pingsPerHour: ceiling for
// BACKGROUND checks (warm/revive/sweep) so health probes never eat the quota
// real requests need. Manual "test" buttons bypass the ceiling.
export const FREE_LANES = {
  zen: { keyless: true, pingsPerHour: 40, note: 'Free models need no account.' },
  kilo: { keyless: true, pingsPerHour: 30, note: 'Anonymous tier: free models only, about 200 requests/hour per IP.' },
  ovh: { keyless: true, pingsPerHour: 60, note: 'Anonymous tier: about 2 requests/minute per IP per model. An OVH access token lifts the cap.' },
  llm7: { keyless: true, pingsPerHour: 40, note: 'Anonymous key: about 10 requests/minute on turbo models. An LLM7 token lifts the cap.' },
};

const DEFAULT_PINGS_PER_HOUR = 60;
const HOUR_MS = 3_600_000;
const pingLog = new Map(); // provider id -> timestamps within the last hour

export function laneInfo(providerId) {
  return FREE_LANES[providerId] ?? { keyless: false, pingsPerHour: DEFAULT_PINGS_PER_HOUR, note: 'Needs your key; uses the provider\'s free tier.' };
}

function recent(providerId, now) {
  const list = (pingLog.get(providerId) ?? []).filter((t) => now - t < HOUR_MS);
  pingLog.set(providerId, list);
  return list;
}

// Counts a ping against the provider's hour. Returns false (and counts
// nothing) when a background check would exceed the ceiling.
export function takePing(providerId, { force = false, now = Date.now() } = {}) {
  const list = recent(providerId, now);
  if (!force && list.length >= laneInfo(providerId).pingsPerHour) return false;
  list.push(now);
  return true;
}

export function pingsUsed(providerId, now = Date.now()) {
  return recent(providerId, now).length;
}

export function resetPingBudget() {
  pingLog.clear();
}
