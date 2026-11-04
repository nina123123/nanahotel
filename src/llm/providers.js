/**
 * Domestic LLM providers reachable through the OpenAI-compatible chat-completions API.
 * Values per RESEARCH-llm.md §1/§6 and the SPEC addendum. Request quirks (thinking switches, GLM
 * tool_choice/tool_stream, Kimi temperature/max_tokens, Qwen parallel_tool_calls) are applied by
 * llm/client.js from these presets.
 *
 * extraBody: fields merged into every request. When thinking is turned on (LLM_THINKING=on) the
 * "disabled" switches are removed and Qwen gets enable_thinking: true (its default is off).
 */
export const PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
    extraBody: { thinking: { type: 'disabled' } },
  }),
  qwen: Object.freeze({
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-flash',
    keyEnv: 'DASHSCOPE_API_KEY',
    extraBody: { enable_thinking: false, parallel_tool_calls: true },
  }),
  kimi: Object.freeze({
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    keyEnv: 'MOONSHOT_API_KEY',
    extraBody: { thinking: { type: 'disabled' } },
    // Moonshot's default completion limit is only 1024 tokens; reasoning models fix their own temperature.
    noTemperature: true,
    maxTokens: 8192,
    thinkingMaxTokens: 16000,
  }),
  glm: Object.freeze({
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flash',
    keyEnv: 'ZHIPUAI_API_KEY',
    altKeyEnvs: Object.freeze(['ZAI_API_KEY']),
    // GLM-4.5+ think by default; 5.3+ reject "disabled" (the client drops it for those models).
    extraBody: { thinking: { type: 'disabled' } },
    noToolChoice: true,
    toolStream: true,
  }),
  doubao: Object.freeze({
    label: '豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    // Ark needs a versioned model id or an endpoint id (ep-…); display names return 404.
    model: 'doubao-seed-2-1-lite-260915',
    keyEnv: 'ARK_API_KEY',
    extraBody: { thinking: { type: 'disabled' } },
  }),
});

export const DEFAULT_PROVIDER = 'deepseek';
export const DEFAULT_TEMPERATURE = 0.3;

const ALIASES = Object.freeze({
  deepseek: 'deepseek',
  qwen: 'qwen', dashscope: 'qwen', tongyi: 'qwen', bailian: 'qwen', alibaba: 'qwen', aliyun: 'qwen',
  kimi: 'kimi', moonshot: 'kimi', moonshotai: 'kimi',
  glm: 'glm', zhipu: 'glm', zhipuai: 'glm', zai: 'glm', bigmodel: 'glm',
  doubao: 'doubao', ark: 'doubao', volcengine: 'doubao', volces: 'doubao',
});

const HOST_HINTS = [
  [/deepseek\.com$/i, 'deepseek'],
  [/dashscope(-intl)?\.aliyuncs\.com$/i, 'qwen'],
  [/moonshot\.(cn|ai)$/i, 'kimi'],
  [/(bigmodel\.cn|z\.ai)$/i, 'glm'],
  [/volces\.com$/i, 'doubao'],
];

/** 'Moonshot' → 'kimi'; unknown → null. */
export function normalizeProvider(name) {
  const key = String(name || '').trim().toLowerCase();
  return Object.hasOwn(ALIASES, key) ? ALIASES[key] : null;
}

/** Best guess of the provider behind a base URL (so quirks apply even with a custom LLM_BASE_URL). */
export function inferProvider(baseUrl) {
  let host = '';
  try {
    host = new URL(String(baseUrl)).hostname;
  } catch {
    return null;
  }
  for (const [re, id] of HOST_HINTS) if (re.test(host)) return id;
  return null;
}

function pick(env, key) {
  const v = env?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
}

function parseTemperature(raw) {
  if (raw === '') return DEFAULT_TEMPERATURE;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : DEFAULT_TEMPERATURE;
}

function truthy(raw) {
  return /^(1|on|true|yes|enabled?)$/i.test(raw);
}

/**
 * env → LLM settings. The result can be spread into createLlmClient: `createLlmClient({ ...cfg, fetch })`.
 * Overrides: LLM_PROVIDER (default: inferred from LLM_BASE_URL, else deepseek), LLM_API_KEY, LLM_BASE_URL, LLM_MODEL,
 * LLM_TEMPERATURE, LLM_THINKING=on.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ provider: string, label: string, baseUrl: string, apiKey: string, model: string, temperature: number,
 *             thinking: boolean, configured: boolean, keyEnv: string, warnings: string[] }}
 */
export function resolveLlmConfig(env = {}) {
  const warnings = [];
  const requested = pick(env, 'LLM_PROVIDER');
  const customUrl = pick(env, 'LLM_BASE_URL');
  const inferred = customUrl ? inferProvider(customUrl) : null;
  let provider = requested ? normalizeProvider(requested) : inferred || DEFAULT_PROVIDER;
  if (!provider) {
    provider = inferred || DEFAULT_PROVIDER;
    warnings.push(`未知的 LLM_PROVIDER「${requested}」，已改用 ${provider}（可选：${Object.keys(PROVIDERS).join('/')}）`);
  }
  if (inferred && inferred !== provider) {
    warnings.push(`LLM_BASE_URL 看起来是 ${PROVIDERS[inferred].label} 的地址，但 LLM_PROVIDER 是 ${provider}；请求参数会按 ${PROVIDERS[provider].label} 处理，请确认两者一致`);
  }
  const preset = PROVIDERS[provider];
  const keyEnvs = [preset.keyEnv, ...(preset.altKeyEnvs || [])];
  const apiKey = pick(env, 'LLM_API_KEY') || keyEnvs.map((k) => pick(env, k)).find(Boolean) || '';
  const baseUrl = (customUrl || preset.baseUrl).replace(/\/+$/, '');
  return {
    provider,
    label: preset.label,
    baseUrl,
    apiKey,
    model: pick(env, 'LLM_MODEL') || preset.model,
    temperature: parseTemperature(pick(env, 'LLM_TEMPERATURE')),
    thinking: truthy(pick(env, 'LLM_THINKING')),
    configured: Boolean(apiKey),
    keyEnv: preset.keyEnv,
    warnings,
  };
}
