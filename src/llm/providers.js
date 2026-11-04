/**
 * LLM providers of the US edition: Anthropic (Claude, the default) and OpenAI. The scripted demo model
 * (scripted-llm.js) needs neither and is wired by the server/app directly.
 *
 * Env (documented for the owner in docs/LIVE.md):
 *   LLM_PROVIDER       anthropic | openai (default: the provider whose key is set, Anthropic when both or neither)
 *   ANTHROPIC_API_KEY  ANTHROPIC_MODEL (default claude-opus-5-5)
 *   OPENAI_API_KEY     OPENAI_MODEL    (default gpt-5-mini)
 *   LLM_EFFORT         low | medium | high (also xhigh, max on Claude) — how much the model thinks before answering
 *   ANTHROPIC_FALLBACKS=off   turns off Anthropic's server-side refusal fallback (on by default)
 *   Advanced: LLM_API_KEY, LLM_MODEL, LLM_BASE_URL (a gateway), LLM_TEMPERATURE (OpenAI non-reasoning models only),
 *   LLM_THINKING=on (same as LLM_EFFORT=high).
 */
export const PROVIDERS = Object.freeze({
  anthropic: Object.freeze({
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5-5',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    keyPrefix: 'sk-ant-',
    consoleUrl: 'https://console.anthropic.com',
  }),
  openai: Object.freeze({
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    // VERIFY: a current, tool-capable model id on the owner's OpenAI account (override with OPENAI_MODEL).
    model: 'gpt-5-mini',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    keyPrefix: 'sk-',
    consoleUrl: 'https://platform.openai.com',
  }),
});

export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_TEMPERATURE = 0.3;

const EFFORTS = Object.freeze({
  anthropic: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  openai: Object.freeze(['minimal', 'low', 'medium', 'high']),
});

const ALIASES = Object.freeze({
  anthropic: 'anthropic', claude: 'anthropic', 'anthropic-claude': 'anthropic',
  openai: 'openai', gpt: 'openai', chatgpt: 'openai', 'open-ai': 'openai',
});

const HOST_HINTS = [
  [/(^|\.)anthropic\.com$/i, 'anthropic'],
  [/(^|\.)openai\.com$/i, 'openai'],
  [/(^|\.)openai\.azure\.com$/i, 'openai'],
];

/** 'Claude' → 'anthropic', 'ChatGPT' → 'openai'; unknown → null. */
export function normalizeProvider(name) {
  const key = String(name || '').trim().toLowerCase();
  return Object.hasOwn(ALIASES, key) ? ALIASES[key] : null;
}

/** Best guess of the provider behind a base URL (so a custom LLM_BASE_URL still gets the right request format). */
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

function falsy(raw) {
  return /^(0|off|false|no|disabled?|none)$/i.test(raw);
}

/**
 * env → LLM settings. The result can be spread into createLlmClient: `createLlmClient({ ...cfg, fetch })`.
 * Warnings are English, one line each, and never contain a key.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ provider: string, label: string, baseUrl: string, apiKey: string, model: string, temperature: number,
 *             thinking: boolean, configured: boolean, keyEnv: string, warnings: string[],
 *             effort: string|null, fallbacks: 'default'|null }}
 *   effort/fallbacks are additions of the US edition (createLlmClient reads them; other callers can ignore them).
 */
export function resolveLlmConfig(env = {}) {
  const warnings = [];
  const requested = pick(env, 'LLM_PROVIDER');
  const customUrl = pick(env, 'LLM_BASE_URL');
  const inferred = customUrl ? inferProvider(customUrl) : null;
  const keyed = (id) => Boolean(pick(env, PROVIDERS[id].keyEnv));
  const byKey = keyed('anthropic') ? 'anthropic' : keyed('openai') ? 'openai' : null;

  let provider = requested ? normalizeProvider(requested) : inferred || byKey || DEFAULT_PROVIDER;
  if (!provider) {
    provider = inferred || byKey || DEFAULT_PROVIDER;
    warnings.push(`Unknown LLM_PROVIDER "${requested.slice(0, 40)}"; using ${provider} (options: ${Object.keys(PROVIDERS).join(', ')})`);
  }
  if (inferred && inferred !== provider) {
    warnings.push(`LLM_BASE_URL looks like ${PROVIDERS[inferred].label}, but LLM_PROVIDER is ${provider}; requests use the ${PROVIDERS[provider].label} format, so make sure the two match`);
  }
  const preset = PROVIDERS[provider];
  const ownKey = pick(env, preset.keyEnv);
  const apiKey = pick(env, 'LLM_API_KEY') || ownKey;
  if (ownKey && !ownKey.startsWith(preset.keyPrefix)) {
    warnings.push(`${preset.keyEnv} doesn't look like a ${preset.label} key (they start with "${preset.keyPrefix}")`);
  }
  if (provider === 'anthropic' && keyed('openai') && !keyed('anthropic') && !pick(env, 'LLM_API_KEY')) {
    warnings.push('LLM_PROVIDER is anthropic but only OPENAI_API_KEY is set; set ANTHROPIC_API_KEY or LLM_PROVIDER=openai');
  }
  const baseUrl = (customUrl || preset.baseUrl).replace(/\/+$/, '');
  const thinking = truthy(pick(env, 'LLM_THINKING'));

  const rawEffort = pick(env, 'LLM_EFFORT').toLowerCase();
  let effort = null;
  if (rawEffort) {
    if (EFFORTS[provider].includes(rawEffort)) effort = rawEffort;
    else warnings.push(`LLM_EFFORT "${rawEffort.slice(0, 20)}" is not valid for ${preset.label} (options: ${EFFORTS[provider].join(', ')}); using the default`);
  }
  if (!effort) effort = thinking ? 'high' : provider === 'anthropic' ? 'medium' : null;

  return {
    provider,
    label: preset.label,
    baseUrl,
    apiKey,
    model: pick(env, preset.modelEnv) || pick(env, 'LLM_MODEL') || preset.model,
    temperature: parseTemperature(pick(env, 'LLM_TEMPERATURE')),
    thinking,
    configured: Boolean(apiKey),
    keyEnv: preset.keyEnv,
    warnings,
    effort,
    fallbacks: falsy(pick(env, 'ANTHROPIC_FALLBACKS')) ? null : 'default',
  };
}
