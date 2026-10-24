// @body:organ=muscle type=provider role="SambaNova adapter: free rate-limited tier via the OpenAI-compatible factory"
import { makeOpenAIProvider } from './factory.mjs';

export const { id, defaultBase, isEnabled, listCredentials, protocolOf, listModels, listModelIds, freeSources, chat, classifyError } = makeOpenAIProvider({
  id: 'sambanova',
  defaultBase: 'https://api.sambanova.ai/v1',
});
