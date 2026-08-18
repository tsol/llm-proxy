export type ProviderId = 'local' | 'gonka' | 'gonka-dahl' | 'gonka-api' | 'joingonka' | 'gonka-mingles' | 'gonka-router-io' | 'gonkabroker' | 'hyperfusion' | 'google' | 'cursor' | 'deepseek' | 'groq' | 'cerebras' | 'openrouter';

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

/** Optional adapter override when chat/completions is the wrong upstream shape. */
export interface PreparedChatRequest {
  url: string;
  headers?: Record<string, string>;
  payload: unknown;
  /** Image-out models should not SSE; return one JSON completion. */
  forceSync?: boolean;
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
  /** Sort order in model catalogs (lower = first). */
  displayOrder?: number;
  /** Cursor SDK local agent workspace (cursor provider only). */
  cwd?: string;
  /** Default context window when upstream omits it (cursor provider). */
  defaultContextLength?: number;
  /** Extra HTTP headers appended to every upstream request (e.g., OpenRouter HTTP-Referer / X-Title). */
  extraHeaders?: Record<string, string>;
  /** Rate limits. */
  rateLimits?: ProviderRateLimits;
  /** Declarative per-model overrides. */
  modelQuirks?: Record<string, ModelQuirkOverrides>;
}

export interface ProviderRateLimits {
  tokensPerMinute?: number;
  requestsPerMinute?: number;
  requestsPerHour?: number;
  requestsPerDay?: number;
}

export interface ModelQuirkOverrides {
  contextLength?: number;
  capabilities?: ModelCapabilities;
  maxTokens?: number;
  excludePattern?: RegExp;
  /** Max in-flight (concurrent) upstream requests for this model.
   *  Undefined = unlimited. When set, requests over the limit are
   *  queued FIFO (see services/concurrency-queue.ts). */
  concurrent?: number;
  /** When true, this model joins the preferred group pool. Requests for any
   *  model in the group wait up to RETRY_QUEUE_WAIT_TIMEOUT for the FIRST
   *  available slot across ALL group members, then fall through the chain. */
  inPreferredGroup?: boolean;
  /** Force reasoning_effort for models that inline thinking tokens in
   *  output content (e.g. MiniMax <think> blocks). Applied in adaptForModel(). */
  reasoningEffort?: string;
  /** Generation-param overrides merged into the upstream payload (only applied
   *  when the client did NOT set the value explicitly). Calms degenerate
   *  repetition on small/free-tier models (e.g. MiniMax on gonka). Applied in
   *  adaptForModel(). All fields optional; unset = leave upstream default. */
  temperature?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  topP?: number;
  /** Non-standard knob some backends accept (vLLM/gonka-adjacent). Omitted by
   *  default for OpenAI-compatible providers — opt-in only. */
  repetitionPenalty?: number;
  /** Decreasing LM Studio context lengths to try if the preferred window
   *  does not fit in VRAM (e.g. 32768 → 16384 → 8192 → 4096). */
  contextSteps?: number[];
  /** GPU pre-hook before forwarding a local (LM Studio) chat request. */
  gpuPrep?: {
    /** Stop ComfyUI and unload other LM Studio models so this one owns VRAM. */
    exclusive?: boolean;
  };
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
  /**
   * Rewrite URL / payload for this model. Default OpenAI-compat adapters
   * inject image-out `modalities` here; Google image models switch to
   * native generateContent.
   */
  prepareChat?(
    model: string,
    body: ChatCompletionRequest,
    defaults: { url: string; headers: Record<string, string> },
  ): PreparedChatRequest | void;
  /** Map a non-OpenAI (or OpenRouter `images[]`) payload to chat.completion. */
  normalizeChatResponse?(raw: unknown, model: string): unknown;
}

// ─────────────────────────────────────────────────────────────
// Dashboard WebSocket events
// ─────────────────────────────────────────────────────────────

export type DashboardEventType =
  | 'request:start'
  | 'request:forward'
  | 'request:response'
  | 'request:fallback'
  | 'request:error'
  | 'request:complete'
  | 'stream:chunk'
  | 'rate_limit:hit'
  | 'cost:logged';

export interface DashboardEvent {
  type: DashboardEventType;
  timestamp: string; // ISO 8601
  requestId: string; // uuid, сквозной через весь lifecycle
  // Контекст запроса
  endpointPrefix?: string; // '/v1', '/deepseek/v1' и т.д.
  requestedModel?: string;
  effectiveModel?: string;
  fallbackFrom?: string;
  // Провайдер
  provider?: ProviderId;
  // Тело
  userMessagePreview?: string;
  // Ответ
  status?: number;
  completionPreview?: string;
  stream?: boolean;
  // Токены / стоимость
  tokensIn?: number;
  tokensOut?: number;
  dollars?: number;
  // Fallback
  fallbackReason?: string;
  fallbackChain?: string[];
  fallbackAttempt?: number;
  // Ошибка
  errorCode?: string;
  errorDetail?: string;
  // Дополнительно
  metadata?: Record<string, unknown>;
}

/** Alias for DashboardEvent — used by logger emitter interface. */
export type LogEvent = DashboardEvent;
