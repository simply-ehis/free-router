// @body:organ=immune role="client API key verification"
import { safeEqual } from './util/http.mjs';

export function generateApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `frk_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function hashApiKey(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hasApiKey(key, records = []) {
  return (await findApiKey(key, records)) !== null;
}

// Returns the matching key record (label attribution for usage/logs) or null.
export async function findApiKey(key, records = []) {
  if (typeof key !== 'string' || key.length < 8 || key.length > 512) return null;
  const hash = await hashApiKey(key);
  for (const entry of records) if (entry?.enabled !== false && safeEqual(hash, entry?.hash)) return entry;
  return null;
}

export function publicApiKeys(records = []) {
  return records.map(({ id, label, createdAt, enabled }) => ({ id, label, createdAt, enabled: enabled !== false }));
}
