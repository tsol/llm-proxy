// Provider registry — all providers self-register at import time.
// To add a new provider, add its import below.

import { registerStandardProvider } from './registry';
import type { ProviderConfig, ProviderAdapter, ProviderId, ProviderPricing, OpenAIModel } from '../types';

// Re-export the registry functions for backward compatibility
export { getProvider, allProviders, getProviderIds, getProviderEntry, getProviderEntries, getProviderDisplayOrder } from './registry';

// Legacy aliases (used by catalog.ts, routes/)
export function providerIds(): ProviderId[] {
  const { getProviderIds } = require('./registry') as typeof import('./registry');
  return getProviderIds() as ProviderId[];
}

// ---- Register all providers ----

import { providerConfigs } from '../config';
import { createProvider } from './base';

for (const [id, config] of Object.entries(providerConfigs)) {
  const displayOrder = config.displayOrder ?? 99;
  registerStandardProvider(
    id as ProviderId,
    displayOrder,
    config,
    (cfg: ProviderConfig) => createProvider(cfg),
  );
}