// Loads model-metadata.json — hand-curated context lengths, rate limits, model types.
// These serve as defaults; env vars and API responses take precedence.

import fs from 'fs';
import path from 'path';
import type { ProviderRateLimits, ModelQuirkOverrides } from '../types';

interface ModelMeta {
  contextLength?: number;
  maxTokens?: number;
  type?: string;
  concurrent?: number;
  inPreferredGroup?: boolean;
  reasoningEffort?: string;
  temperature?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  topP?: number;
  repetitionPenalty?: number;
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

/** Get model quirks for a provider from the metadata file (key = exact id OR
 *  prefix boundary, e.g. `MiniMaxAI/` matches every MiniMax model id). */
export function getMetadataModelQuirks(providerId: string): Record<string, ModelQuirkOverrides> {
  const models = loadMetadata()[providerId]?.models ?? {};
  const quirks: Record<string, ModelQuirkOverrides> = {};
  for (const [key, meta] of Object.entries(models)) {
    quirks[key] = {
      ...(meta.contextLength ? { contextLength: meta.contextLength } : {}),
      ...(meta.maxTokens ? { maxTokens: meta.maxTokens } : {}),
      ...(meta.concurrent !== undefined ? { concurrent: meta.concurrent } : {}),
      ...(meta.inPreferredGroup !== undefined ? { inPreferredGroup: meta.inPreferredGroup } : {}),
      ...(meta.reasoningEffort ? { reasoningEffort: meta.reasoningEffort } : {}),
      ...(meta.temperature !== undefined ? { temperature: meta.temperature } : {}),
      ...(meta.frequencyPenalty !== undefined ? { frequencyPenalty: meta.frequencyPenalty } : {}),
      ...(meta.presencePenalty !== undefined ? { presencePenalty: meta.presencePenalty } : {}),
      ...(meta.topP !== undefined ? { topP: meta.topP } : {}),
      ...(meta.repetitionPenalty !== undefined ? { repetitionPenalty: meta.repetitionPenalty } : {}),
    };
  }
  return quirks;
}