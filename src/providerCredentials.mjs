// @body:organ=brain role="AES-GCM envelope for native provider keys in Worker KV: dashboard key changes survive isolate eviction, config in KV stays keyless"
import { importKey, encode, decode } from './compatCredentials.mjs';

const encoder = new TextEncoder();

// COMPAT_CREDENTIALS_KEY encrypts all Worker-stored credentials (compat
// instances + native provider keys) — one binding to manage per deployment.
let credentialSecret = null;

export function configureProviderCredentials(secret) {
  credentialSecret = typeof secret === 'string' && secret ? secret : null;
}

export function hasProviderCredentialsKey() {
  return typeof credentialSecret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(credentialSecret);
}

// Envelope: {version, providers: {<id>: {iv, ciphertext}}}. Plaintext is the
// provider's raw keys array (strings and {key, enabled} entries preserved;
// an empty array means "the user cleared this provider" and must survive);
// AAD binds each ciphertext to its provider id so entries can't be swapped.
export async function encryptProviderKeys(keysByProvider, secret) {
  const key = await importKey(secret, 'encrypt');
  const providers = {};
  for (const [id, keys] of Object.entries(keysByProvider)) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(keys));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, key, plaintext);
    providers[id] = { iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted)) };
  }
  return JSON.stringify({ version: 1, providers });
}

export async function decryptProviderKeys(serialized, secret) {
  let envelope;
  try { envelope = JSON.parse(serialized); } catch { throw new Error('Stored provider keys are malformed'); }
  if (envelope?.version !== 1 || !envelope.providers || typeof envelope.providers !== 'object' || Array.isArray(envelope.providers)) {
    throw new Error('Stored provider keys have an unsupported format');
  }
  const key = await importKey(secret, 'decrypt');
  const out = {};
  for (const [id, entry] of Object.entries(envelope.providers)) {
    if (typeof entry?.iv !== 'string' || typeof entry?.ciphertext !== 'string') throw new Error('Stored provider key entry is malformed');
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decode(entry.iv), additionalData: encoder.encode(id) },
        key,
        decode(entry.ciphertext),
      );
      const keys = JSON.parse(new TextDecoder().decode(plaintext));
      if (!Array.isArray(keys)) throw new Error('not an array');
      out[id] = keys;
    } catch {
      throw new Error('Could not decrypt provider keys; check COMPAT_CREDENTIALS_KEY');
    }
  }
  return out;
}

// Surgical update: only the touched provider is rewritten, so untouched
// providers keep seeding from env bindings on boot. An empty keys array is
// stored deliberately (clearing a provider must survive eviction).
export async function persistProviderKeys(cfg, store, path, providerId) {
  if (!credentialSecret) throw new Error('COMPAT_CREDENTIALS_KEY is not configured');
  const p = cfg.providers?.[providerId];
  if (!p) throw new Error(`unknown provider: ${providerId}`);
  let keysByProvider = {};
  const existing = store.read(path);
  if (existing) {
    try { keysByProvider = await decryptProviderKeys(existing, credentialSecret); }
    catch (err) { throw new Error(`existing provider key envelope is unreadable: ${err.message}`); }
  }
  keysByProvider[providerId] = Array.isArray(p.keys) ? p.keys : [];
  const serialized = await encryptProviderKeys(keysByProvider, credentialSecret);
  await store.writeDurable(path, serialized);
}
