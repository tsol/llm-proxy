import type { ProviderPricing } from '../types';

/**
 * Official Google AI Studio paid-tier text rates (USD per 1M tokens).
 * Source: https://ai.google.dev/gemini-api/docs/pricing (user snapshot 2026-06)
 *
 * Notes:
 * - Pro / 3.1 Pro use <=200k prompt tier (higher above 200k).
 * - Audio / image / video / grounding billed separately — not reflected here.
 * - "latest" aliases map to current generation equivalents below.
 */
const GOOGLE_PRICING: Record<string, ProviderPricing> = {
  // Gemini 3.5
  'gemini-3.5-flash': { inputPerMillion: 1.5, outputPerMillion: 9 },

  // Gemini 3.1
  'gemini-3.1-flash-lite': { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  'gemini-3.1-pro-preview': { inputPerMillion: 2, outputPerMillion: 12 },
  'gemini-3.1-pro-preview-customtools': { inputPerMillion: 2, outputPerMillion: 12 },

  // Gemini 3
  'gemini-3-flash-preview': { inputPerMillion: 0.5, outputPerMillion: 3 },

  // Gemini 2.5
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4 },

  // Gemini 2.0 (deprecated Jun 2026 — rates still listed)
  'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'gemini-2.0-flash-lite': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
};

/** First matching rule wins. Patterns are tested against normalized model id. */
const PRICING_RULES: Array<{ match: RegExp; key: keyof typeof GOOGLE_PRICING }> = [
  { match: /^gemini-3\.5-flash/, key: 'gemini-3.5-flash' },
  { match: /^gemini-3\.1-flash-lite/, key: 'gemini-3.1-flash-lite' },
  { match: /^gemini-3\.1-pro-preview-customtools/, key: 'gemini-3.1-pro-preview-customtools' },
  { match: /^gemini-3\.1-pro-preview/, key: 'gemini-3.1-pro-preview' },
  { match: /^gemini-3-flash-preview/, key: 'gemini-3-flash-preview' },
  { match: /^gemini-flash-lite-latest$/, key: 'gemini-3.1-flash-lite' },
  { match: /^gemini-flash-latest$/, key: 'gemini-3.5-flash' },
  { match: /^gemini-pro-latest$/, key: 'gemini-3.1-pro-preview' },
  { match: /^gemini-2\.5-flash-lite/, key: 'gemini-2.5-flash-lite' },
  { match: /^gemini-2\.0-flash-lite/, key: 'gemini-2.0-flash-lite' },
  { match: /^gemini-2\.5-pro/, key: 'gemini-2.5-pro' },
  { match: /^gemini-2\.5-flash/, key: 'gemini-2.5-flash' },
  { match: /^gemini-2\.0-flash/, key: 'gemini-2.0-flash' },
  { match: /flash-lite|flash_lite/, key: 'gemini-3.1-flash-lite' },
  { match: /3\.1.*pro/, key: 'gemini-3.1-pro-preview' },
  { match: /\bpro\b/, key: 'gemini-2.5-pro' },
  { match: /3\.5.*flash|^gemini-3\.5/, key: 'gemini-3.5-flash' },
  { match: /3.*flash/, key: 'gemini-3-flash-preview' },
  { match: /flash/, key: 'gemini-2.5-flash' },
  { match: /gemma/, key: 'gemini-2.5-flash-lite' }, // no official Gemma API rates in docs
];

export function normalizeGoogleModelId(model: string): string {
  return model.replace(/^models\//, '').trim();
}

export function getGoogleModelPricing(
  model: string,
  fallback: ProviderPricing,
): ProviderPricing {
  const id = normalizeGoogleModelId(model).toLowerCase();

  const exact = GOOGLE_PRICING[id];
  if (exact) return exact;

  for (const rule of PRICING_RULES) {
    if (rule.match.test(id)) {
      return GOOGLE_PRICING[rule.key];
    }
  }

  return fallback;
}
