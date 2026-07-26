import type { ProviderId, ProviderConfig, ProviderPricing, ModelQuirkOverrides } from './types';
import { appConfig } from './config';
import { matchesModelAllow } from './model-filter';
import {
  getProvider,
  getProviderEntry,
  getProviderDisplayOrder,
} from './providers/registry';

export interface DisplayInput {
  provider: ProviderId;
  upstreamId: string;
  pricing: ProviderPricing;
  contextLength?: number;
  modelType?: string;
}

const GOOGLE_DEDUP_SUFFIX = /-(001|002|latest)$/i;

export function shortAlias(upstreamId: string): string {
  const bare = upstreamId.replace(/^models\//, '').trim();
  const slash = bare.lastIndexOf('/');
  return slash >= 0 ? bare.slice(slash + 1) : bare;
}

function getProviderDefaultContext(id: ProviderId): number | undefined {
  const adapter = getProvider(id);
  return adapter.config.defaultContextLength;
}

function getModelQuirkOverride(
  config: ProviderConfig,
  upstreamId: string,
): ModelQuirkOverrides | undefined {
  if (!config.modelQuirks) return undefined;
  // Try exact match first, then prefix match
  for (const [key, quirk] of Object.entries(config.modelQuirks)) {
    if (upstreamId === key || upstreamId.toLowerCase().startsWith(key.toLowerCase())) {
      return quirk;
    }
  }
  return undefined;
}

export function shouldIncludeModel(input: DisplayInput): boolean {
  // Skip embeddings
  if (input.modelType?.toLowerCase() === 'embedding') return false;

  const id = input.upstreamId.toLowerCase();

  // Provider-specific quirks exclusion
  const adapter = getProvider(input.provider);
  const quirks = adapter.config.modelQuirks;
  if (quirks) {
    const override = getModelQuirkOverride(adapter.config, input.upstreamId);
    if (override?.excludePattern?.test(id)) return false;
  }

  // If MODEL{n}_ALIAS configs exist, only show those in the root catalog.
  // Each TRY entry is "provider/model" — match BOTH parts, not just model.
  if (appConfig.modelAliases && appConfig.modelAliases.size > 0) {
    let included = false;
    for (const [_alias, chain] of appConfig.modelAliases) {
      for (const entry of chain) {
        const slashIdx = entry.indexOf('/');
        const chainProvider = slashIdx > 0 ? entry.slice(0, slashIdx).toLowerCase() : '';
        const chainModel = slashIdx > 0 ? entry.slice(slashIdx + 1).toLowerCase() : entry.toLowerCase();
        if (input.provider === chainProvider) {
          if (
            id === chainModel ||
            id.endsWith(`/${chainModel}`) ||
            chainModel.endsWith(`/${id}`)
          ) {
            included = true;
            break;
          }
        }
      }
      if (included) break;
    }
    if (!included) return false;
  }

  // Allow-list filtering (MODEL_ALLOW env var)
  if (
    !matchesModelAllow(
      appConfig.modelAllow[input.provider],
      input.upstreamId,
    )
  ) {
    return false;
  }

  return true;
}

export function isGoogleDuplicate(
  upstreamId: string,
  allUpstreamIds: Set<string>,
): boolean {
  if (!upstreamId.startsWith('models/')) return false;
  const bare = upstreamId.replace(/^models\//, '');
  if (!GOOGLE_DEDUP_SUFFIX.test(bare)) return false;

  const canonical = bare.replace(GOOGLE_DEDUP_SUFFIX, '');
  if (canonical === bare) return false;

  const canonicalId = `models/${canonical}`;
  return allUpstreamIds.has(canonicalId);
}

/** Resolve context length using API data → model quirks → provider default → global fallbacks. */
export function resolveContextLength(input: DisplayInput): number | undefined {
  // 1. API-provided context length — valid unless it's a LM Studio leak
  if (input.contextLength && input.contextLength > 0) {
    const entry = getProviderEntry(input.provider);
    const leakThreshold = 200_000; // default for LM Studio
    if (input.provider === 'local' && leakThreshold && input.contextLength > leakThreshold) {
      // skip — this is a model-card max, not allocated VRAM
    } else {
      return input.contextLength;
    }
  }

  // 2. Model quirk overrides from provider config
  const adapter = getProvider(input.provider);
  const override = getModelQuirkOverride(adapter.config, input.upstreamId);
  if (override?.contextLength && override.contextLength > 0) {
    return override.contextLength;
  }

  // 3. Provider-level default context length
  const providerDefault = getProviderDefaultContext(input.provider);
  if (providerDefault && providerDefault > 0) return providerDefault;

  // 4. Legacy hardcoded per-pattern rules (Google / DeepSeek remain for now)
  if (input.provider === 'google') {
    const bare = input.upstreamId.replace(/^models\//, '');
    if (/flash-lite|flash_lite/i.test(bare)) return 1_000_000;
    if (/gemini-3\.5-flash/i.test(bare)) return 1_000_000;
    if (/gemini-.*-flash/i.test(bare)) return 1_000_000;
    if (/gemini-.*-pro/i.test(bare)) return 1_000_000;
    if (/gemini-flash/i.test(bare)) return 1_000_000;
    if (/gemini-pro/i.test(bare)) return 1_000_000;
    if (/antigravity/i.test(bare)) return 1_000_000;
    if (/gemma/i.test(bare)) return 128_000;
  }

  return undefined;
}

export function buildPrettyName(input: DisplayInput): string {
  return shortAlias(input.upstreamId);
}

export function buildSafeModelId(input: DisplayInput): string {
  return shortAlias(input.upstreamId);
}

/** Sort key using provider displayOrder from registry — no more hardcoded if-chains. */
export function displaySortKey(safeId: string, provider: string): string {
  const order = getProviderDisplayOrder(provider);
  return `${String(order).padStart(2, '0')}:${safeId}`;
}