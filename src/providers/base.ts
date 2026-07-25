import axios from 'axios';
import type {
  ModelListResult,
  OpenAIModel,
  ProviderAdapter,
  ProviderConfig,
  ProviderPricing,
} from '../types';
import { resilientGet } from '../services/resilient-http';
import { getGoogleModelPricing } from './google-pricing';
import {
  getDeepSeekModelCapabilities,
  getDeepSeekModelLimits,
  getDeepSeekModelPricing,
} from './deepseek-pricing';
import { resolveModelCapabilities } from '../model-capabilities';
import { CursorProvider } from './cursor';

const CONTEXT_LENGTH_KEYS = [
  'context_length',
  'context_window',
  'context_size',
  'max_context_length',
  'max_model_len',
  'max_input_tokens',
] as const;

const MAX_TOKENS_KEYS = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const;

function firstInt(
  payload: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
  }
  return undefined;
}

function mapUpstreamModel(
  raw: Record<string, unknown>,
  ownedBy: string,
): OpenAIModel | null {
  const id = raw.id;
  if (typeof id !== 'string' || !id.trim()) return null;

  const contextLength = firstInt(raw, CONTEXT_LENGTH_KEYS);
  const maxTokens = firstInt(raw, MAX_TOKENS_KEYS);

  return {
    id,
    object: 'model',
    created: typeof raw.created === 'number' ? raw.created : 0,
    owned_by: typeof raw.owned_by === 'string' ? raw.owned_by : ownedBy,
    ...(contextLength ? { context_length: contextLength } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  };
}

const GOOGLE_MODELS: OpenAIModel[] = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-image',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-3-pro-image',
  'gemini-omni-flash-preview',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-pro-latest',
].map((id) => ({
  id,
  object: 'model' as const,
  created: 0,
  owned_by: 'google',
}));

export abstract class OpenAICompatibleProvider implements ProviderAdapter {
  readonly config: ProviderConfig;
  protected pricingOverrides = new Map<string, ProviderPricing>();

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  get id() {
    return this.config.id;
  }

  chatCompletionsUrl(): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  }

  resolveModel(requestedModel?: string): string {
    return requestedModel?.trim() || this.config.defaultModel;
  }

  getPricing(model: string): ProviderPricing {
    return (
      this.pricingOverrides.get(model) ?? this.config.pricing
    );
  }

  async listModelsDetailed(): Promise<ModelListResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/models`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    try {
      const { data } = await resilientGet<{ data?: Array<Record<string, unknown>> }>(url, {
        headers,
        timeout: 15000,
      });
      if (Array.isArray(data?.data) && data.data.length > 0) {
        const models = data.data
          .map((m) => mapUpstreamModel(m, this.config.ownedBy))
          .filter((m): m is OpenAIModel => m !== null);
        if (models.length > 0) {
          return { models, source: 'live' };
        }
      }
    } catch {
      // fall through to static list
    }
    return { models: this.staticModels(), source: 'fallback' };
  }

  async listModels(): Promise<OpenAIModel[]> {
    return (await this.listModelsDetailed()).models;
  }

  protected abstract staticModels(): OpenAIModel[];
}

export class LmStudioProvider extends OpenAICompatibleProvider {
  async listModelsDetailed(): Promise<ModelListResult> {
    const result = await super.listModelsDetailed();
    const metaById = await this.fetchLmStudioMeta();

    const models = result.models
      .map((m) => {
        const meta = metaById.get(m.id) ?? metaById.get(m.id.toLowerCase());
        const capabilities = resolveModelCapabilities('local', m.id, {
          vision: meta?.vision,
          modelType: meta?.type,
        });
        return {
          ...m,
          context_length: meta?.contextLength,
          max_context_length: meta?.maxContext,
          model_type: meta?.type,
          capabilities,
        };
      })
      .filter((m) => m.model_type?.toLowerCase() !== 'embedding');

    return { models, source: result.source };
  }

  private async fetchLmStudioMeta(): Promise<
    Map<
      string,
      {
        contextLength?: number;
        maxContext?: number;
        type?: string;
        vision?: boolean;
      }
    >
  > {
    const raw = new Map<
      string,
      {
        loadedContext?: number;
        maxContext?: number;
        type?: string;
        vision?: boolean;
      }
    >();
    const root = this.config.baseUrl.replace(/\/v1\/?$/, '');

    await this.mergeLmStudioV1Meta(root, raw);
    await this.mergeLmStudioV0Meta(root, raw);

    const map = new Map<
      string,
      {
        contextLength?: number;
        maxContext?: number;
        type?: string;
        vision?: boolean;
      }
    >();
    for (const [key, meta] of raw) {
      map.set(key, {
        // Only the allocated runtime window — never model-card max_context_length.
        contextLength: meta.loadedContext,
        maxContext: meta.maxContext,
        type: meta.type,
        vision: meta.vision,
      });
    }
    return map;
  }

  private putLmStudioMeta(
    map: Map<
      string,
      {
        loadedContext?: number;
        maxContext?: number;
        type?: string;
        vision?: boolean;
      }
    >,
    id: string,
    patch: {
      loadedContext?: number;
      maxContext?: number;
      type?: string;
      vision?: boolean;
    },
  ): void {
    const trimmed = id.trim();
    if (!trimmed) return;

    for (const key of [trimmed, trimmed.toLowerCase()]) {
      const prev = map.get(key) ?? {};
      const next = {
        loadedContext:
          patch.loadedContext !== undefined
            ? patch.loadedContext
            : prev.loadedContext,
        maxContext:
          patch.maxContext !== undefined ? patch.maxContext : prev.maxContext,
        type: patch.type ?? prev.type,
        vision: patch.vision !== undefined ? patch.vision : prev.vision,
      };
      map.set(key, next);
    }
  }

  private lmStudioHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  private async mergeLmStudioV1Meta(
    root: string,
    map: Map<
      string,
      {
        loadedContext?: number;
        maxContext?: number;
        type?: string;
        vision?: boolean;
      }
    >,
  ): Promise<void> {
    try {
      const { data } = await resilientGet<{
        models?: Array<{
          key?: string;
          id?: string;
          type?: string;
          max_context_length?: number;
          loaded_instances?: Array<{
            config?: { context_length?: number };
          }>;
          variants?: string[];
          capabilities?: { vision?: boolean };
        }>;
      }>(`${root}/api/v1/models`, {
        headers: this.lmStudioHeaders(),
        timeout: 15000,
      });

      for (const model of data.models ?? []) {
        const id = model.key ?? model.id;
        if (!id) continue;

        let loadedContext: number | undefined;
        for (const inst of model.loaded_instances ?? []) {
          const loaded = inst.config?.context_length;
          if (typeof loaded === 'number' && loaded > 0) {
            loadedContext = loaded;
            break;
          }
        }

        const maxContext =
          typeof model.max_context_length === 'number' &&
          model.max_context_length > 0
            ? model.max_context_length
            : undefined;

        const patch = {
          loadedContext,
          maxContext,
          type: model.type,
          vision: model.capabilities?.vision,
        };
        this.putLmStudioMeta(map, id, patch);
        for (const variant of model.variants ?? []) {
          this.putLmStudioMeta(map, variant, patch);
        }
      }
    } catch {
      // v0 API may still have metadata
    }
  }

  private async mergeLmStudioV0Meta(
    root: string,
    map: Map<
      string,
      {
        loadedContext?: number;
        maxContext?: number;
        type?: string;
        vision?: boolean;
      }
    >,
  ): Promise<void> {
    try {
      const { data } = await resilientGet<{
        data?: Array<{
          id?: string;
          type?: string;
          state?: string;
          loaded_context_length?: number;
          max_context_length?: number;
        }>;
      }>(`${root}/api/v0/models`, {
        headers: this.lmStudioHeaders(),
        timeout: 15000,
      });

      for (const model of data.data ?? []) {
        if (!model.id) continue;

        const isLoaded = model.state?.toLowerCase() === 'loaded';
        const loadedContext =
          isLoaded &&
          typeof model.loaded_context_length === 'number' &&
          model.loaded_context_length > 0
            ? model.loaded_context_length
            : undefined;
        const maxContext =
          typeof model.max_context_length === 'number' &&
          model.max_context_length > 0
            ? model.max_context_length
            : undefined;

        this.putLmStudioMeta(map, model.id, {
          loadedContext,
          maxContext,
          type: model.type,
          vision: model.type?.toLowerCase() === 'vlm' ? true : undefined,
        });
      }
    } catch {
      // no native LM Studio metadata available
    }
  }

  protected staticModels(): OpenAIModel[] {
    return [
      {
        id: this.config.defaultModel,
        object: 'model',
        created: 0,
        owned_by: this.config.ownedBy,
      },
    ];
  }
}

export class GoogleProvider extends OpenAICompatibleProvider {
  protected staticModels(): OpenAIModel[] {
    return GOOGLE_MODELS;
  }

  getPricing(model: string): ProviderPricing {
    return getGoogleModelPricing(model, this.config.pricing);
  }
}

const STATIC_DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

export class GroqProvider extends OpenAICompatibleProvider {
  private modelMaxTokens = new Map<string, number>();

  async listModelsDetailed(): Promise<ModelListResult> {
    const result = await super.listModelsDetailed();

    // Parse per-model pricing + max_tokens from Groq API response.
    // Groq returns dollars-per-token; convert to dollars-per-million.
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/models`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    try {
      const { data } = await resilientGet<{
        data?: Array<{
          id: string;
          pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
          max_completion_tokens?: number;
        }>;
      }>(url, { headers, timeout: 15000 });
      for (const m of data?.data ?? []) {
        if (!m.id) continue;
        if (m.pricing) {
          const inputPrice = Number(m.pricing.prompt ?? 0);
          const outputPrice = Number(m.pricing.completion ?? 0);
          const cacheRead = Number(m.pricing.input_cache_read ?? 0);
          this.pricingOverrides.set(m.id, {
            inputPerMillion: inputPrice > 0 ? inputPrice * 1_000_000 : 0,
            outputPerMillion: outputPrice > 0 ? outputPrice * 1_000_000 : 0,
            ...(cacheRead > 0 ? { cacheReadPerMillion: cacheRead * 1_000_000 } : {}),
          });
        }
        if (typeof m.max_completion_tokens === 'number' && m.max_completion_tokens > 0) {
          this.modelMaxTokens.set(m.id, m.max_completion_tokens);
        }
      }
    } catch {
      // pricing stays at provider defaults
    }

    return result;
  }

  /** Get the model's max output token limit (from API), or undefined if unknown. */
  getModelMaxTokens(modelId: string): number | undefined {
    return this.modelMaxTokens.get(modelId);
  }

  protected staticModels(): OpenAIModel[] {
    // Never used as fallback — live fetch always succeeds for Groq.
    // Return default model only as a last resort.
    return [
      {
        id: this.config.defaultModel,
        object: 'model' as const,
        created: 0,
        owned_by: this.config.ownedBy,
      },
    ];
  }
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  getPricing(model: string): ProviderPricing {
    return getDeepSeekModelPricing(model, this.config.pricing);
  }

  async listModelsDetailed(): Promise<ModelListResult> {
    const result = await super.listModelsDetailed();
    const models = result.models.map((m) => this.enrichModel(m));
    return { models, source: result.source };
  }

  protected staticModels(): OpenAIModel[] {
    return STATIC_DEEPSEEK_MODELS.map((id) =>
      this.enrichModel({
        id,
        object: 'model',
        created: 0,
        owned_by: this.config.ownedBy,
      }),
    );
  }

  private enrichModel(model: OpenAIModel): OpenAIModel {
    const limits = getDeepSeekModelLimits(model.id);
    return {
      ...model,
      owned_by: model.owned_by || this.config.ownedBy,
      context_length: model.context_length ?? limits.contextLength,
      max_tokens: model.max_tokens ?? limits.maxTokens,
      capabilities: getDeepSeekModelCapabilities(),
    };
  }
}

export function createProvider(config: ProviderConfig): ProviderAdapter {
  switch (config.id) {
    case 'local':
      return new LmStudioProvider(config);
    case 'gonka': {
      const { GonkaProvider } = require('./gonka') as typeof import('./gonka');
      return new GonkaProvider(config);
    }
    case 'google':
      return new GoogleProvider(config);
    case 'cursor':
      return new CursorProvider(config);
    case 'deepseek':
      return new DeepSeekProvider(config);
    case 'groq':
      return new GroqProvider(config);
    default:
      throw new Error(`Unsupported provider: ${config.id}`);
  }
}
