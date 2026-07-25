import type { ProviderPricing } from '../types';

/** Composer family rates (USD per 1M tokens). */
const COMPOSER_PRICING: ProviderPricing = {
  inputPerMillion: 0.5,
  outputPerMillion: 2.5,
  cacheReadPerMillion: 0.2,
};

export function normalizeCursorModelId(model: string): string {
  return model.replace(/@.*$/, '').trim().toLowerCase();
}

export function getCursorModelPricing(
  model: string,
  fallback: ProviderPricing,
): ProviderPricing {
  const id = normalizeCursorModelId(model);
  if (id.startsWith('composer')) return COMPOSER_PRICING;
  return fallback;
}
