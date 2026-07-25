import { Cursor } from '@cursor/sdk';
import type { ModelSelection } from '@cursor/sdk';
import type {
  ModelListResult,
  OpenAIModel,
  ProviderAdapter,
  ProviderConfig,
  ProviderPricing,
} from '../types';
import { getCursorModelPricing } from './cursor-pricing';

const STATIC_CURSOR_MODELS = ['composer-2.5@fast=false'];

export function parseCursorModelSelection(upstreamId: string): ModelSelection {
  const raw = upstreamId.trim();
  const at = raw.indexOf('@');
  if (at < 0) return { id: raw };

  const id = raw.slice(0, at).trim();
  const paramStr = raw.slice(at + 1);
  const params = paramStr
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return { id: pair, value: 'true' };
      return {
        id: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
      };
    });

  return params.length > 0 ? { id, params } : { id };
}

function variantUpstreamId(modelId: string, params: ModelSelection['params']): string {
  if (!params?.length) return modelId;
  const key = params.map((p) => `${p.id}=${p.value}`).join(',');
  return `${modelId}@${key}`;
}

export class CursorProvider implements ProviderAdapter {
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  get id() {
    return this.config.id;
  }

  /** Cursor chat uses the SDK, not HTTP forwarding. */
  chatCompletionsUrl(): string {
    return '';
  }

  resolveModel(requestedModel?: string): string {
    const raw = requestedModel?.trim() || this.config.defaultModel;
    // Bare composer-2.5 defaults to non-fast (SDK default variant is fast=true).
    if (/^composer-2\.5$/i.test(raw)) return 'composer-2.5@fast=false';
    return raw;
  }

  getPricing(model: string): ProviderPricing {
    return getCursorModelPricing(model, this.config.pricing);
  }

  async listModelsDetailed(): Promise<ModelListResult> {
    if (!this.config.apiKey) {
      return { models: this.staticModels(), source: 'fallback' };
    }

    try {
      const sdkModels = await Cursor.models.list({ apiKey: this.config.apiKey });
      const models = this.mapSdkModels(sdkModels);
      if (models.length > 0) {
        return { models, source: 'live' };
      }
    } catch {
      // fall through to static list
    }

    return { models: this.staticModels(), source: 'fallback' };
  }

  async listModels(): Promise<OpenAIModel[]> {
    return (await this.listModelsDetailed()).models;
  }

  private mapSdkModels(
    sdkModels: Array<{
      id: string;
      displayName?: string;
      variants?: Array<{
        params: ModelSelection['params'];
        displayName?: string;
        isDefault?: boolean;
      }>;
    }>,
  ): OpenAIModel[] {
    const out: OpenAIModel[] = [];
    const seen = new Set<string>();

    for (const model of sdkModels) {
      const base: OpenAIModel = {
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: this.config.ownedBy,
        name: model.displayName ?? model.id,
        context_length: this.config.defaultContextLength,
      };
      if (!seen.has(base.id)) {
        seen.add(base.id);
        out.push(base);
      }

      for (const variant of model.variants ?? []) {
        const upstreamId = variantUpstreamId(model.id, variant.params);
        if (seen.has(upstreamId)) continue;
        seen.add(upstreamId);
        out.push({
          id: upstreamId,
          object: 'model',
          created: 0,
          owned_by: this.config.ownedBy,
          name: variant.displayName ?? model.displayName ?? upstreamId,
          context_length: this.config.defaultContextLength,
        });
      }
    }

    return out;
  }

  private staticModels(): OpenAIModel[] {
    return STATIC_CURSOR_MODELS.map((id) => ({
      id,
      object: 'model' as const,
      created: 0,
      owned_by: this.config.ownedBy,
      context_length: this.config.defaultContextLength,
    }));
  }
}
