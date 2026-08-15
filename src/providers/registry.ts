// Provider Registry — data-driven, plug-in architecture.
// New providers = one file that calls registerProvider() + one import in index.ts.

import type { ProviderConfig, ProviderId, ProviderAdapter, ProviderPricing } from '../types';
export type { ProviderConfig, ProviderId, ProviderAdapter, ProviderPricing };

// ---- Provider quirks — declarative per-provider overrides ----
export interface ProviderQuirks {
  /** Strip these top-level request params before forwarding */
  stripParams?: string[];

  /** Default model capabilities (fallback when API omits them) */
  capabilities?: ModelCapabilities;

  /** Default context length fallback (used when API/upstream omits it) */
  defaultContextLength?: number;

  /** Model ID exclusion patterns specific to this provider */
  excludeModelPatterns?: RegExp[];

  /** Cap max_tokens to model's upstream limit (fetched from API) */
  capMaxTokens?: boolean;

  /** Enable stream garbage detection + retry */
  garbageProtection?: boolean;

  /** Fetch per-model pricing from GET /models API */
  fetchPricingFromApi?: boolean;

  /** Deduplicate Google-style version suffixes */
  dedupGoogleSuffixes?: boolean;

  /** Max context_length leak threshold (local LM Studio VRAM alloc vs model-card) */
  ctxLeakThreshold?: number;
}

// ---- Model capabilities ----
export type Modality = 'text' | 'image' | 'audio' | 'video';

export interface ModelCapabilities {
  input_modalities: Modality[];
  output_modalities: Modality[];
}

export const TEXT_ONLY: ModelCapabilities = { input_modalities: ['text'], output_modalities: ['text'] };
export const TEXT_AND_IMAGE: ModelCapabilities = { input_modalities: ['text', 'image'], output_modalities: ['text'] };
export const VISION_AND_IMAGE_OUT: ModelCapabilities = {
  input_modalities: ['text', 'image'],
  output_modalities: ['text', 'image'],
};

// ---- Rate limits ----
export interface ProviderRateLimit {
  tokensPerMinute?: number;
  requestsPerMinute?: number;
  requestsPerHour?: number;
  requestsPerDay?: number;
}

// ---- Model-level quirks (per-model overrides) ----
export interface ModelQuirkOverrides {
  contextLength?: number;
  capabilities?: ModelCapabilities;
  maxTokens?: number;
  excludePattern?: RegExp;
}

// ---- Provider entry ----
export interface ProviderEntry {
  id: string;
  displayOrder: number;
  config: ProviderConfig;
  factory: (cfg: ProviderConfig) => ProviderAdapter;
}

const registry = new Map<string, ProviderEntry>();

export function registerProvider(entry: ProviderEntry): void {
  if (registry.has(entry.id)) {
    console.warn(`[registry] duplicate provider id: ${entry.id}, overwriting`);
  }
  registry.set(entry.id, entry);
}

export function getProviderEntry(id: string): ProviderEntry | undefined {
  return registry.get(id);
}

export function getProviderEntries(): ProviderEntry[] {
  return [...registry.values()].sort((a, b) => a.displayOrder - b.displayOrder);
}

export function getProviderIds(): string[] {
  return getProviderEntries().map((e) => e.id);
}

export function getProviderDisplayOrder(id: string): number {
  return registry.get(id)?.displayOrder ?? 99;
}

// ---- Adapter cache (like old getProvider()) ----
const adapterCache = new Map<string, ProviderAdapter>();

export function getProvider(id: string): ProviderAdapter {
  let adapter = adapterCache.get(id);
  if (adapter) return adapter;

  const entry = registry.get(id);
  if (!entry) throw new Error(`Unknown provider: ${id}`);

  adapter = entry.factory(entry.config);
  adapterCache.set(id, adapter);
  return adapter;
}

export function allProviders(): ProviderAdapter[] {
  return getProviderIds().map(getProvider);
}

// ---- Compatibility: keep ProviderId type working ----
export function registerStandardProvider(
  id: ProviderId,
  displayOrder: number,
  config: ProviderConfig,
  factory: (cfg: ProviderConfig) => ProviderAdapter,
): void {
  registerProvider({ id, displayOrder, config, factory });
}