import { normalizeProvider, inferProvider } from './providers.js';
import { createChatEngine, defaultSleep, defaultGenId } from './core.js';
import { createOpenAiAdapter, DEFAULT_TEMPERATURE } from './openai.js';
import { createAnthropicAdapter } from './anthropic.js';

/**
 * The LLM client the agent loop uses: `createLlmClient({ ...resolveLlmConfig(env), fetch })` →
 * `{ chat({ messages, tools, signal, onTextDelta }), provider, model }`.
 *
 * - provider 'anthropic' (default): Claude through the Messages API (anthropic.js);
 * - provider 'openai': the Chat Completions API (openai.js), also any OpenAI-compatible gateway via baseUrl.
 *
 * chat() contract (both providers): text is streamed through onTextDelta as it arrives; the promise resolves to
 * `{ content, toolCalls: [{ id, name, arguments: string, invalidArguments? }], finishReason, usage, encryptedContent? }`.
 * Failures reject with LlmError (code + English `userMessage`); a caller abort rejects with the abort reason.
 * Retries (429/5xx/network/timeouts) happen only before any text reached the caller. timeoutMs is the idle limit
 * per attempt, totalTimeoutMs one deadline for the whole call.
 */

export { LlmError, LLM_ERROR_MESSAGES, REASON_MESSAGES, createSseParser, parseToolArguments, retryDelayMs, parseRetryAfter } from './core.js';
export { classifyProviderError, buildRequestBody } from './openai.js';
export { classifyAnthropicError, buildAnthropicRequest } from './anthropic.js';

/**
 * @param {{ baseUrl?: string, apiKey: string, model: string, provider?: string, temperature?: number, thinking?: boolean,
 *           effort?: string|null, fallbacks?: 'default'|null, fetch?: typeof fetch, timeoutMs?: number, totalTimeoutMs?: number,
 *           maxRetries?: number, stream?: boolean, maxTokens?: number, extraBody?: object, promptCaching?: boolean,
 *           eagerToolStreaming?: boolean, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>, random?: () => number,
 *           genId?: () => string, onRetry?: (info: { attempt: number, delayMs: number, error: import('./core.js').LlmError }) => void }} opts
 *   Unknown extra fields (label, keyEnv, configured, warnings from resolveLlmConfig) are ignored.
 */
export function createLlmClient({
  baseUrl,
  apiKey,
  model,
  provider,
  temperature = DEFAULT_TEMPERATURE,
  thinking = false,
  effort,
  fallbacks = 'default',
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 60000,
  totalTimeoutMs = 120000,
  maxRetries = 2,
  stream = true,
  maxTokens,
  extraBody,
  promptCaching = true,
  eagerToolStreaming,
  sleep = defaultSleep,
  random = Math.random,
  genId = defaultGenId,
  onRetry,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createLlmClient: fetch is required');
  const kind = normalizeProvider(provider) || inferProvider(baseUrl) || 'openai';
  const adapter = kind === 'anthropic'
    ? createAnthropicAdapter({
      baseUrl, apiKey, model, effort: effort === undefined ? (thinking ? 'high' : undefined) : effort, maxTokens, fallbacks, eagerToolStreaming, promptCaching, genId,
    })
    : createOpenAiAdapter({ baseUrl, apiKey, model, temperature, effort, thinking, maxTokens, extraBody, genId });
  const engine = createChatEngine(adapter, { fetch: fetchImpl, timeoutMs, totalTimeoutMs, maxRetries, stream, maxTokens, sleep, random, onRetry });
  return { chat: engine.chat, provider: kind, model: adapter.model };
}
