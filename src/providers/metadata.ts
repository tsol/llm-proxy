// Loads model-metadata.json — hand-curated context lengths, rate limits, model types.
// These serve as defaults; env vars and API responses take precedence.

import fs from 'fs';
import path from 'path';
import type { ProviderRateLimits, ModelQuirkOverrides } from '../types';

interface ModelMeta {
  contextLength?: number;
  maxTokens?: number;
  type?: string;
}

interface ProviderMeta {
  rateLimits?: ProviderRateLimits;
  models?: Record<string, ModelMeta>;
}

type MetadataFile = Record<string, ProviderMeta>;

let cached: MetadataFile | null = null;

function loadMetadata(): MetadataFile {
  if (cached) return cached;
  try {
    const filePath = path.resolve(__dirname, 'model-metadata.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    cached = JSON.parse(raw) as MetadataFile;
  } catch {
    console.warn('[metadata] failed to load model-metadata.json, using empty defaults');
    cached = {};
  }
  return cached;
}

/** Get rate limits for a provider from the metadata file. */
export function getMetadataRateLimits(providerId: string): ProviderRateLimits {
  return loadMetadata()[providerId]?.rateLimits ?? {};
}

/** Get model quirks for a provider from the metadata file (key = model id prefix match). */
export function getMetadataModelQuirks(providerId: string): Record<string, ModelQuirkOverrides> {
  const models = loadMetadata()[providerId]?.models ?? {};
  const quirks: Record<string, ModelQuirkOverrides> = {};
  for (const [key, meta] of Object.entries(models)) {
    quirks[key] = {
      ...(meta.contextLength ? { contextLength: meta.contextLength } : {}),
      ...(meta.maxTokens ? { maxTokens: meta.maxTokens } : {}),
    };
  }
  return quirks;
}