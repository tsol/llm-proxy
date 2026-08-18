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
  contextSteps?: number[];
  gpuPrep?: { exclusive?: boolean };
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
      ...(meta.contextSteps && meta.contextSteps.length > 0
        ? { contextSteps: [...meta.contextSteps] }
        : {}),
      ...(meta.gpuPrep ? { gpuPrep: { ...meta.gpuPrep } } : {}),
    };
  }
  return quirks;
}

/**
 * Resolve the effective quirk for a model. Keys may be exact ids, prefix
 * boundaries (`MiniMaxAI/`), or substrings (`qwen2-vl` matches
 * `lmstudio-community/qwen2-vl-7b-instruct`). Matching keys merge
 * shortest→longest so a specific entry overrides a broad prefix.
 */
export function resolveModelQuirk(
  model: string,
  modelQuirks?: Record<string, ModelQuirkOverrides>,
): ModelQuirkOverrides | undefined {
  if (!modelQuirks) return undefined;
  const matched = Object.keys(modelQuirks)
    .filter((key) => quirkKeyMatches(model, key))
    .sort((a, b) => a.length - b.length);

  if (matched.length === 0) return undefined;
  const merged: ModelQuirkOverrides = {};
  for (const key of matched) {
    Object.assign(merged, modelQuirks[key]);
  }
  return merged;
}

export function quirkKeyMatches(model: string, key: string): boolean {
  if (!key) return false;
  if (model === key) return true;
  if (key.endsWith('/')) return model.startsWith(key);
  if (model.startsWith(`${key}/`)) return true;
  const lowerModel = model.toLowerCase();
  const lowerKey = key.toLowerCase();
  return lowerModel.includes(lowerKey);
}