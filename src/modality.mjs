// @body:organ=immune type=catalog role="model kind classifier: provider metadata first, token-aware name rules second; only chat models enter the routing pool"

// Kinds a model can be. Only 'chat' is routable — everything else is kept out
// of the pool (but remembered, with a reason, so the dashboard can show why).
export const KINDS = ['chat', 'image', 'video', 'audio', 'embedding', 'rerank', 'moderation', 'ocr', 'other'];

const MEDIA_PRIORITY = ['video', 'image', 'audio'];

function normModality(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  if (v.startsWith('embedding') || v === 'vector') return 'embedding';
  if (v.startsWith('image') || v === 'img') return 'image';
  if (v.startsWith('video')) return 'video';
  if (v.startsWith('audio') || v === 'speech' || v === 'voice') return 'audio';
  if (v === 'text' || v === 'string') return 'text';
  return v;
}

function modalitySet(list) {
  if (!Array.isArray(list)) return new Set();
  return new Set(list.map(normModality).filter(Boolean));
}

// "text+image->text" (OpenRouter-style) → output-side set.
function outputSideOf(modality) {
  if (typeof modality !== 'string' || !modality.includes('->')) return new Set();
  return modalitySet(modality.split('->').pop().split(/[+,]/));
}

function outputModalities(meta) {
  const direct = [meta.architecture?.output_modalities, meta.output_modalities, meta.modalities?.output, meta.modalities?.outputs];
  for (const list of direct) {
    const set = modalitySet(list);
    if (set.size > 0) return set;
  }
  for (const text of [meta.architecture?.modality, meta.modality]) {
    const set = outputSideOf(text);
    if (set.size > 0) return set;
  }
  return new Set();
}

const TYPE_FIELD_KINDS = {
  chat: 'chat', 'chat-completion': 'chat', chat_completion: 'chat', completion: 'chat', 'text-generation': 'chat', text_generation: 'chat',
  language: 'chat', llm: 'chat', responses: 'chat', conversational: 'chat',
  embedding: 'embedding', embeddings: 'embedding', embed: 'embedding', 'feature-extraction': 'embedding',
  image: 'image', 'image-generation': 'image', image_generation: 'image', 'text-to-image': 'image', 'image-to-image': 'image',
  video: 'video', 'video-generation': 'video', video_generation: 'video', 'text-to-video': 'video', 'image-to-video': 'video',
  audio: 'audio', tts: 'audio', stt: 'audio', asr: 'audio', speech: 'audio', transcription: 'audio', audio_speech: 'audio', audio_transcription: 'audio',
  'text-to-speech': 'audio', 'automatic-speech-recognition': 'audio', 'speech-to-text': 'audio', music: 'audio',
  rerank: 'rerank', reranker: 'rerank', reranking: 'rerank',
  moderation: 'moderation', moderations: 'moderation', classification: 'moderation',
  ocr: 'ocr',
};

function typeFieldKind(meta) {
  for (const field of ['mode', 'task', 'model_type', 'pipeline_tag', 'category', 'type']) {
    const raw = meta[field];
    if (typeof raw !== 'string') continue;
    const kind = TYPE_FIELD_KINDS[raw.trim().toLowerCase()];
    if (kind) return { kind, reason: `provider says ${field}: ${raw}` };
  }
  return null;
}

function endpointKind(meta) {
  const list = meta.supported_endpoints ?? meta.endpoints;
  if (!Array.isArray(list) || list.length === 0) return null;
  const joined = list.map((e) => String(e).toLowerCase()).join(' ');
  if (/chat\/completions|\/responses|\/messages/.test(joined)) return { kind: 'chat', reason: 'provider lists a chat endpoint' };
  if (/embeddings/.test(joined)) return { kind: 'embedding', reason: 'provider lists only an embeddings endpoint' };
  if (/images/.test(joined)) return { kind: 'image', reason: 'provider lists only an images endpoint' };
  if (/audio/.test(joined)) return { kind: 'audio', reason: 'provider lists only an audio endpoint' };
  return null;
}

// Gemini native listing: the method list says what the model can be asked to do.
function geminiMethodKind(meta) {
  const methods = meta.supportedGenerationMethods;
  if (!Array.isArray(methods) || methods.length === 0) return null;
  if (methods.includes('generateContent') || methods.includes('streamGenerateContent')) return { kind: 'chat', reason: 'supports generateContent' };
  if (methods.includes('embedContent') || methods.includes('batchEmbedContents') || methods.includes('embedText')) return { kind: 'embedding', reason: 'embedding-only methods' };
  if (methods.includes('bidiGenerateContent')) return { kind: 'audio', reason: 'live/bidirectional model' };
  if (methods.includes('predictLongRunning')) return { kind: 'video', reason: 'long-running media generation' };
  if (methods.includes('predict')) return { kind: 'image', reason: 'predict-only media model' };
  return { kind: 'other', reason: `no chat method (${methods.join(', ')})` };
}

// Structured signals the provider itself sent. Returns { kind, reason } or null.
function fromMeta(meta) {
  if (meta === null || typeof meta !== 'object') return null;
  if (meta.active === false) return { kind: 'other', reason: 'marked inactive by the provider' };
  if (meta.capabilities && typeof meta.capabilities === 'object' && meta.capabilities.completion_chat === false) {
    return { kind: 'other', reason: 'provider says completion_chat is false' };
  }
  const gem = geminiMethodKind(meta);
  if (gem && gem.kind !== 'chat') return gem;
  const out = outputModalities(meta);
  if (out.size > 0) {
    if (out.has('embedding')) return { kind: 'embedding', reason: 'provider output is embeddings' };
    for (const media of MEDIA_PRIORITY) {
      if (out.has(media)) return { kind: media, reason: `provider output includes ${media}` };
    }
    if (out.has('text')) return { kind: 'chat', reason: 'provider output is text', strong: true };
  }
  const typed = typeFieldKind(meta);
  if (typed) return typed;
  const endpoint = endpointKind(meta);
  if (endpoint) return endpoint;
  return gem;
}

const wordsOf = (id) => String(id).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const anyWord = (ws, set) => ws.some((w) => set.has(w));
const anyPrefix = (ws, prefixes) => ws.some((w) => prefixes.some((p) => w.startsWith(p)));

const VIDEO_WORDS = new Set(['video', 'videos', 'sora', 'runway', 'pika', 'luma', 'kling', 'hailuo', 'seedance', 'vidu', 'pixverse', 'mochi', 'ltx', 'ltxv', 'svd', 'framepack', 'animatediff', 'cogvideo', 'cogvideox', 'hunyuanvideo', 'wan', 't2v', 'i2v', 'v2v', 's2v', 'veo']);
const VIDEO_PREFIXES = ['veo', 'kling', 'cogvideo', 'seedance', 'hailuo', 'luma'];
const VIDEO_CHAT_HINTS = new Set(['understanding', 'llava', 'vl', 'chat', 'caption', 'qa', 'reason', 'reasoning']);
const IMAGE_WORDS = new Set(['image', 'images', 'imagen', 'dalle', 'midjourney', 'sdxl', 'sd3', 'flux', 'cogview', 'kolors', 'ideogram', 'recraft', 'seedream', 'hidream', 'kandinsky', 'pixart', 'firefly', 'omnigen', 't2i', 'txt2img', 'img2img']);
const IMAGE_CHAT_HINTS = new Set(['vision', 'vl', 'caption', 'understanding', 'understand', 'ocr', 'chat']);
const AUDIO_WORDS = new Set(['tts', 'asr', 'stt', 'whisper', 'speech', 'voice', 'orpheus', 'kokoro', 'parakeet', 'canary', 'paraformer', 'sensevoice', 'cosyvoice', 'lyria', 'musicgen', 'suno', 'elevenlabs', 'bark', 'xtts', 'realtime', 'live']);
const AUDIO_CHAT_HINTS = new Set(['instruct', 'chat', 'omni']);
const EMBED_WORDS = new Set(['gte', 'minilm', 'mxbai', 'clip', 'siglip', 'nvclip', 'sbert', 'splade', 'vector']);
const MODERATION_WORDS = new Set(['moderation', 'moderations', 'safety', 'reward', 'classifier', 'jailbreak', 'toxicity']);

// Name rules in priority order. Word-based on purpose: "luma" must be a whole
// word, not a substring of some longer chat-model name.
const NAME_RULES = [
  ['other', 'batch', (_ws, lower) => lower.endsWith(':batch'), 'batch API variant'],
  ['moderation', 'moderation', (ws) => anyWord(ws, MODERATION_WORDS) || ws.some((w) => w.includes('guard')) || anyPrefix(ws, ['shield']), 'moderation/safety classifier'],
  ['rerank', 'rerank', (ws) => ws.some((w) => w.includes('rerank')) || anyWord(ws, new Set(['colbert'])), 'reranker'],
  ['embedding', 'embedding', (ws) => ws.some((w) => w.includes('embed')) || anyPrefix(ws, ['bge']) || ws.some((w) => w === 'e5' || /^e5\d?$/.test(w)) || anyWord(ws, EMBED_WORDS), 'embedding model'],
  ['ocr', 'ocr', (ws) => ws.some((w) => w === 'ocr' || w.endsWith('ocr')), 'OCR specialist'],
  ['video', 'video', (ws, lower) => (anyWord(ws, VIDEO_WORDS) || anyPrefix(ws, VIDEO_PREFIXES) || ws.some((w) => /^wan\d/.test(w)) || /cosmos.*(predict|transfer)/.test(lower)) && !anyWord(ws, VIDEO_CHAT_HINTS), 'video generation'],
  ['image', 'image', (ws, lower) => (anyWord(ws, IMAGE_WORDS) || anyPrefix(ws, ['flux', 'imagen', 'dall']) || /dall-?e|stable-?diffusion|nano-?banana/.test(lower)) && !anyWord(ws, IMAGE_CHAT_HINTS), 'image generation'],
  ['audio', 'audio', (ws) => anyWord(ws, AUDIO_WORDS) || anyPrefix(ws, ['transcri', 'whisper']) || (ws.includes('audio') && !anyWord(ws, AUDIO_CHAT_HINTS)), 'audio / speech'],
  ['other', 'other', (ws) => ws.includes('aqa'), 'attributed-QA service'],
];

const AFTER_METADATA = new Set(['batch', 'moderation', 'rerank', 'embedding', 'ocr']);

function nameKind(id, allowed) {
  const lower = String(id).toLowerCase();
  const ws = wordsOf(lower);
  for (const [kind, label, test, text] of NAME_RULES) {
    if (allowed && !allowed.has(label)) continue;
    if (test(ws, lower)) return { kind, reason: `name looks like ${text}` };
  }
  return null;
}

// classifyModel(id, meta?) → { kind, chat, reason, source }
// meta is the raw model object from the provider listing when it has one.
// Metadata that clearly says "media/embedding output" wins outright. Metadata
// that says "text" is trusted for media kinds, but cheap name checks still
// catch classifiers (guard/rerank/embed/OCR) that also answer with text.
export function classifyModel(id, meta = null) {
  const m = fromMeta(meta);
  if (m && m.kind !== 'chat') return { kind: m.kind, chat: false, reason: m.reason, source: 'metadata' };
  const byName = nameKind(id, m?.strong ? AFTER_METADATA : null);
  if (byName) return { kind: byName.kind, chat: false, reason: byName.reason, source: 'name' };
  return { kind: 'chat', chat: true, reason: m ? m.reason : 'no non-chat signal', source: m ? 'metadata' : 'name' };
}

export function isChatModel(id, meta = null) {
  return classifyModel(id, meta).chat;
}
