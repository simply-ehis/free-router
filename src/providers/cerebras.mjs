// @body:organ=muscle type=provider role="Cerebras adapter: free rate-limited tier via the OpenAI-compatible factory"
import { makeOpenAIProvider } from './factory.mjs';

export const { id, defaultBase, isEnabled, listCredentials, protocolOf, listModelIds, freeSources, chat, classifyError } = makeOpenAIProvider({
  id: 'cerebras',
  defaultBase: 'https://api.cerebras.ai/v1',
});
