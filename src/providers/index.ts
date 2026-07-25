import { providerConfigs } from '../config';
import { createProvider } from './base';
import type { ProviderAdapter, ProviderId } from '../types';

const adapters = new Map<ProviderId, ProviderAdapter>();

export function getProvider(id: ProviderId): ProviderAdapter {
  let adapter = adapters.get(id);
  if (!adapter) {
    adapter = createProvider(providerConfigs[id]);
    adapters.set(id, adapter);
  }
  return adapter;
}

export function allProviders(): ProviderAdapter[] {
  return (Object.keys(providerConfigs) as ProviderId[]).map(getProvider);
}

export function providerIds(): ProviderId[] {
  return Object.keys(providerConfigs) as ProviderId[];
}
