// @body:nerve=providers — every provider adapter registers here and ONLY here
import * as zen from './zen.mjs';
import * as openrouter from './openrouter.mjs';
import * as groq from './groq.mjs';
import * as gemini from './gemini.mjs';
import * as cerebras from './cerebras.mjs';
import * as sambanova from './sambanova.mjs';
import * as mistral from './mistral.mjs';
import * as openaiCompat from './openaiCompat.mjs';
import * as kilo from './kilo.mjs';
import * as ovh from './ovh.mjs';
import * as llm7 from './llm7.mjs';
import * as zai from './zai.mjs';
import * as nvidia from './nvidia.mjs';
import * as qwen from './qwen.mjs';
import * as kluster from './kluster.mjs';
import * as huggingface from './huggingface.mjs';
import * as nous from './nous.mjs';
import * as cloudflare from './cloudflare.mjs';

export const registry = [zen, openrouter, groq, gemini, cerebras, sambanova, mistral, openaiCompat, kilo, ovh, llm7, zai, nvidia, qwen, kluster, huggingface, nous, cloudflare];
export const byId = Object.fromEntries(registry.map((p) => [p.id, p]));
