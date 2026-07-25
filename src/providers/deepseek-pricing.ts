import type { ModelCapabilities, ProviderPricing } from '../types';

/**
 * Official DeepSeek API rates (USD per 1M tokens).
 * Source: https://api-docs.deepseek.com/quick_start/pricing (snapshot 2026-06)
 *
 * DeepSeek has no pricing API — rates are synced from the docs page.
 * Input uses cache-miss rate; cache hits billed via cacheReadPerMillion when
 * the upstream usage object reports prompt_cache_hit_tokens.
 */
const DEEPSEEK_PRICING: Record<string, ProviderPricing> = {
  'deepseek-v4-flash': {
    inputPerMillion: 0.14,
    outputPerMillion: 0.28,
    cacheReadPerMillion: 0.0028,
  },
  'deepseek-v4-pro': {
    inputPerMillion: 0.435,
    outputPerMillion: 0.87,
    cacheReadPerMillion: 0.003625,
  },
  // Legacy aliases (deprecated 2026-07-24) — same as v4-flash
  'deepseek-chat': {
    inputPerMillion: 0.14,
    outputPerMillion: 0.28,
    cacheReadPerMillion: 0.0028,
  },
  'deepseek-reasoner': {
    inputPerMillion: 0.14,
    outputPerMillion: 0.28,
    cacheReadPerMillion: 0.0028,
  },
};

const PRICING_RULES: Array<{ match: RegExp; key: keyof typeof DEEPSEEK_PRICING }> = [
  { match: /^deepseek-v4-pro/, key: 'deepseek-v4-pro' },
  { match: /^deepseek-v4-flash/, key: 'deepseek-v4-flash' },
  { match: /^deepseek-reasoner/, key: 'deepseek-reasoner' },
  { match: /^deepseek-chat/, key: 'deepseek-chat' },
  { match: /-pro/, key: 'deepseek-v4-pro' },
  { match: /-flash|deepseek/, key: 'deepseek-v4-flash' },
];

export function normalizeDeepSeekModelId(model: string): string {
  return model.trim().toLowerCase();
}

export function getDeepSeekModelPricing(
  model: string,
  fallback: ProviderPricing,
): ProviderPricing {
  const id = normalizeDeepSeekModelId(model);
  const exact = DEEPSEEK_PRICING[id];
  if (exact) return exact;

  for (const rule of PRICING_RULES) {
    if (rule.match.test(id)) {
      return DEEPSEEK_PRICING[rule.key];
    }
  }

  return fallback;
}

/** Official DeepSeek chat API is text-in / text-out only (no image_url). */
export function getDeepSeekModelCapabilities(): ModelCapabilities {
  return {
    input_modalities: ['text'],
    output_modalities: ['text'],
  };
}

/** Context / output limits from official model details. */
export function getDeepSeekModelLimits(model: string): {
  contextLength: number;
  maxTokens: number;
} {
  const id = normalizeDeepSeekModelId(model);
  if (id === 'deepseek-chat' || id === 'deepseek-reasoner') {
    return { contextLength: 128_000, maxTokens: id === 'deepseek-reasoner' ? 64_000 : 8_192 };
  }
  return { contextLength: 1_000_000, maxTokens: 384_000 };
}
