// @body:organ=muscle type=provider role="Mistral adapter: la plateforme free tier via the OpenAI-compatible factory"
import { makeOpenAIProvider } from './factory.mjs';

export const { id, defaultBase, isEnabled, listCredentials, protocolOf, listModelIds, freeSources, chat, classifyError } = makeOpenAIProvider({
  id: 'mistral',
  defaultBase: 'https://api.mistral.ai/v1',
});
