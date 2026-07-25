export type ProviderId = 'local' | 'gonka' | 'google' | 'cursor' | 'deepseek';

/** Legacy alias used by switch-model.sh / TODO doc */
export type RouterTarget = ProviderId | 'remote';

export interface ProviderPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cursor / DeepSeek cache-read tokens (USD per 1M). */
  cacheReadPerMillion?: number;
}

export type Modality = 'text' | 'image' | 'audio' | 'video';

export interface ModelCapabilities {
  input_modalities: Modality[];
  output_modalities: Modality[];
}

export interface GonkaModelMeta {
  /** Listed in GET /v1/models — callable via chat/completions. */
  routable: boolean;
  supports_tools: boolean;
  supports_reasoning: boolean;
  v_ram_gb?: number;
  hf_repo?: string;
  hf_commit?: string;
  validation_threshold?: number;
}

export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  name?: string;
  context_length?: number;
  /** LM Studio model-card maximum — not the allocated runtime window. */
  max_context_length?: number;
  max_tokens?: number;
  model_type?: string;
  capabilities?: ModelCapabilities;
  gonka?: GonkaModelMeta;
}

export interface OpenAIModelsResponse {
  object: 'list';
  data: OpenAIModel[];
}

export interface ChatMessage {
  role: string;
  content: string | unknown;
}

export interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ProviderConfig {
  id: ProviderId;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  pricing: ProviderPricing;
  ownedBy: string;
  /** Cursor SDK local agent workspace (cursor provider only). */
  cwd?: string;
  /** Default context window when upstream omits it (cursor provider). */
  defaultContextLength?: number;
}

export interface RouterSnapshot {
  provider: ProviderId;
  model: string;
  activeRequests: number;
  pendingSwitch: PendingSwitch | null;
}

export interface PendingSwitch {
  provider: ProviderId;
  model: string;
}

export interface SwitchRequest {
  target?: RouterTarget;
  provider?: ProviderId;
  model?: string;
  force?: boolean;
}

export interface SwitchResult {
  ok: boolean;
  applied: boolean;
  deferred?: boolean;
  message: string;
  state: RouterSnapshot;
}

export interface CompletionRequestContext {
  userRequestText: string;
  userRequestPreview: string;
  requestKb: number;
}

export interface CostEntry {
  model: string;
  tokensIn: number;
  tokensOut: number;
  dollars: number;
  provider: ProviderId;
  userRequestPreview: string;
  requestKb: number;
}

export type ModelListSource = 'live' | 'fallback';

export interface ModelListResult {
  models: OpenAIModel[];
  source: ModelListSource;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly config: ProviderConfig;
  listModels(): Promise<OpenAIModel[]>;
  listModelsDetailed(): Promise<ModelListResult>;
  resolveModel(requestedModel?: string): string;
  getPricing(model: string): ProviderPricing;
  chatCompletionsUrl(): string;
}
