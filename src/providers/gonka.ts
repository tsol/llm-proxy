import type {
  GonkaModelMeta,
  ModelCapabilities,
  ModelListResult,
  OpenAIModel,
} from '../types';
import { resilientGet } from '../services/resilient-http';
import { OpenAICompatibleProvider } from './base';

const GONKA_TEXT: ModelCapabilities = {
  input_modalities: ['text'],
  output_modalities: ['text'],
};

const DEFAULT_MAX_OUTPUT = 16_384;

interface GonkaCapabilityRow {
  id: string;
  context_length?: number;
  max_model_len?: number;
  max_output_tokens?: number;
  supports_tools?: boolean;
  supports_reasoning?: boolean;
  v_ram_gb?: number;
  hf_repo?: string;
  hf_commit?: string;
  validation_threshold?: number;
}

interface GonkaCapabilitiesResponse {
  models?: GonkaCapabilityRow[];
  updated_at?: string;
  source?: string;
}

interface GonkaPricingResponse {
  default_model?: string;
  models?: Array<{ model_id: string; usd_per_million_tokens?: number }>;
  pricing_updated_at?: string;
}

function gonkaApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
}

export class GonkaProvider extends OpenAICompatibleProvider {
  private routableModelIds = new Set<string>();

  getPricing(model: string) {
    return this.pricingOverrides.get(model) ?? this.config.pricing;
  }

  async listModelsDetailed(): Promise<ModelListResult> {
    const root = gonkaApiRoot(this.config.baseUrl);

    const [capabilitiesResult, pricingResult, routableResult] =
      await Promise.allSettled([
        resilientGet<GonkaCapabilitiesResponse>(
          `${root}/api/models/capabilities`,
          { timeout: 15_000, headers: { Accept: 'application/json' } },
        ),
        resilientGet<GonkaPricingResponse>(`${root}/api/pricing`, {
          timeout: 15_000,
          headers: { Accept: 'application/json' },
        }),
        this.fetchRoutableModelIds(),
      ]);

    if (pricingResult.status === 'fulfilled') {
      this.applyPricing(pricingResult.value.data);
    }

    if (routableResult.status === 'fulfilled') {
      this.routableModelIds = routableResult.value;
    } else {
      this.routableModelIds = new Set();
    }

    if (capabilitiesResult.status === 'fulfilled') {
      const rows = capabilitiesResult.value.data.models ?? [];
      if (rows.length > 0) {
        return {
          models: rows.map((row) => this.mapCapability(row)),
          source: 'live',
        };
      }
    }

    const fallback = await super.listModelsDetailed();
    if (fallback.source === 'live' && fallback.models.length > 0) {
      return {
        models: fallback.models.map((model) => this.enrichOpenAiModel(model)),
        source: 'live',
      };
    }

    return { models: this.staticModels(), source: 'fallback' };
  }

  protected staticModels(): OpenAIModel[] {
    const id = this.config.defaultModel || 'MiniMaxAI/MiniMax-M2.7';
    return [
      {
        id,
        object: 'model',
        created: 0,
        owned_by: this.config.ownedBy,
        gonka: {
          routable: true,
          supports_tools: true,
          supports_reasoning: true,
        },
      },
    ];
  }

  private async fetchRoutableModelIds(): Promise<Set<string>> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/models`;
    const { data } = await resilientGet<{ data?: Array<{ id?: string }> }>(url, {
      timeout: 15_000,
      headers: { Accept: 'application/json' },
    });

    const ids = new Set<string>();
    for (const row of data.data ?? []) {
      if (typeof row.id === 'string' && row.id.trim()) {
        ids.add(row.id.trim());
      }
    }
    return ids;
  }

  private applyPricing(data: GonkaPricingResponse): void {
    this.pricingOverrides.clear();
    for (const entry of data.models ?? []) {
      const modelId = entry.model_id?.trim();
      if (!modelId) continue;
      const rate = Number(entry.usd_per_million_tokens ?? 0);
      this.pricingOverrides.set(modelId, {
        inputPerMillion: rate,
        outputPerMillion: rate,
      });
    }
  }

  private mapCapability(row: GonkaCapabilityRow): OpenAIModel {
    const contextLength = row.context_length ?? row.max_model_len;
    const maxTokens =
      row.max_output_tokens && row.max_output_tokens > 0
        ? row.max_output_tokens
        : DEFAULT_MAX_OUTPUT;

    return {
      id: row.id,
      object: 'model',
      created: 0,
      owned_by: this.config.ownedBy,
      ...(contextLength ? { context_length: contextLength } : {}),
      max_tokens: maxTokens,
      capabilities: GONKA_TEXT,
      gonka: this.buildMeta(row),
    };
  }

  private enrichOpenAiModel(model: OpenAIModel): OpenAIModel {
    return {
      ...model,
      capabilities: model.capabilities ?? GONKA_TEXT,
      gonka: {
        routable: this.routableModelIds.has(model.id),
        supports_tools: true,
        supports_reasoning: true,
      },
    };
  }

  private buildMeta(row: GonkaCapabilityRow): GonkaModelMeta {
    const meta: GonkaModelMeta = {
      routable: this.routableModelIds.has(row.id),
      supports_tools: Boolean(row.supports_tools),
      supports_reasoning: Boolean(row.supports_reasoning),
    };

    if (row.v_ram_gb) meta.v_ram_gb = row.v_ram_gb;
    if (row.hf_repo) meta.hf_repo = row.hf_repo;
    if (row.hf_commit) meta.hf_commit = row.hf_commit.slice(0, 8);
    if (row.validation_threshold !== undefined) {
      meta.validation_threshold = row.validation_threshold;
    }

    return meta;
  }
}
