// @body:organ=brain role="AES-GCM encryption for OpenAI-compatible credentials and metadata in Worker KV; exports the shared primitives used by providerCredentials.mjs"
const encoder = new TextEncoder();
let credentialSecret = null;

export function configureCompatCredentials(secret) {
  credentialSecret = typeof secret === 'string' && secret ? secret : null;
}

export function hasCompatCredentialsKey() {
  return typeof credentialSecret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(credentialSecret);
}

export async function persistCompatCredentials(instances, store, path) {
  if (!credentialSecret) throw new Error('COMPAT_CREDENTIALS_KEY is not configured');
  const serialized = await encryptCompatCredentials(instances, credentialSecret);
  await store.writeDurable(path, serialized);
}

function decodeKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('COMPAT_CREDENTIALS_KEY must be a base64url-encoded 32-byte key');
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '=';
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error('COMPAT_CREDENTIALS_KEY must decode to 32 bytes');
  return bytes;
}

export function encode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decode(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function metadataOf({ name, prefix, baseUrl, models }) {
  return { name, prefix, baseUrl, ...(Array.isArray(models) ? { models } : {}) };
}

function associatedData(instance) {
  return encoder.encode(JSON.stringify(metadataOf(instance)));
}
export async function importKey(secret, usage) {
  return crypto.subtle.importKey('raw', decodeKey(secret), { name: 'AES-GCM' }, false, [usage]);
}

export async function encryptCompatCredentials(instances, secret) {
  const key = await importKey(secret, 'encrypt');
  const entries = {};
  for (const inst of instances) {
    if (typeof inst.apiKey !== 'string' || !inst.apiKey) continue;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const additionalData = associatedData(inst);
    const plaintext = encoder.encode(inst.apiKey);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext);
    entries[inst.prefix] = { iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted)) };
  }
  const metadata = instances.map(metadataOf);
  return JSON.stringify({ version: 2, instances: metadata, entries });
}

export async function decryptCompatCredentials(serialized, secret) {
  let envelope;
  try { envelope = JSON.parse(serialized); } catch { throw new Error('Stored compatible endpoint credentials are malformed'); }
  if (![1, 2].includes(envelope?.version) || !Array.isArray(envelope.instances) || !envelope.entries || typeof envelope.entries !== 'object' || Array.isArray(envelope.entries)) {
    throw new Error('Stored compatible endpoint credentials have an unsupported format');
  }
  const key = await importKey(secret, 'decrypt');
  const result = {};
  const metadata = new Map(envelope.instances.filter((item) => typeof item?.prefix === 'string').map((item) => [item.prefix, item]));
  for (const [prefix, entry] of Object.entries(envelope.entries)) {
    if (typeof entry?.iv !== 'string' || typeof entry?.ciphertext !== 'string') throw new Error('Stored compatible endpoint credential is malformed');
    try {
      const instance = metadata.get(prefix);
      if (envelope.version === 2 && !instance) throw new Error('missing endpoint metadata');
      const additionalData = envelope.version === 2 ? associatedData(instance) : encoder.encode(prefix);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decode(entry.iv), additionalData },
        key,
        decode(entry.ciphertext),
      );
      result[prefix] = new TextDecoder().decode(plaintext);
    } catch {
      throw new Error('Could not decrypt compatible endpoint credentials; check COMPAT_CREDENTIALS_KEY');
    }
  }
  return { instances: envelope.instances, credentials: result };
}