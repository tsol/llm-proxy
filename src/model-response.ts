import type { CatalogModel } from './catalog';

export function serializeCatalogModel(m: CatalogModel): Record<string, unknown> {
  return {
    id: m.id,
    name: m.name ?? m.id,
    object: m.object,
    created: m.created,
    owned_by: m.owned_by,
    provider: m.provider,
    pricing: {
      input_per_million: m.pricing.inputPerMillion,
      output_per_million: m.pricing.outputPerMillion,
      ...(m.pricing.cacheReadPerMillion != null
        ? { cache_read_per_million: m.pricing.cacheReadPerMillion }
        : {}),
    },
    is_default: m.is_default,
    ...(m.context_length ? { context_length: m.context_length } : {}),
    ...(m.max_context_length
      ? { max_context_length: m.max_context_length }
      : {}),
    ...(m.max_tokens ? { max_tokens: m.max_tokens } : {}),
    ...(m.capabilities ? { capabilities: m.capabilities } : {}),
    ...(m.gonka ? { gonka: m.gonka } : {}),
  };
}

export function serializeCatalogModelDetail(m: CatalogModel): Record<string, unknown> {
  return {
    ...serializeCatalogModel(m),
    upstream_id: m.upstream_id,
  };
}
