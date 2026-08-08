import axios, { type AxiosResponse } from 'axios';
import type { IncomingHttpHeaders } from 'http';
import type { Response } from 'express';
import type {
  ChatCompletionRequest,
  CompletionRequestContext,
  ModelQuirkOverrides,
  ProviderAdapter,
  ProviderId,
  TokenUsage,
} from '../types';
import { appConfig } from '../config';
import { getAliasGroups } from '../services/alias-store';
import { resilientPost } from './resilient-http';
import {
  captureRequestContext,
  computeCost,
  estimateTokensFromMessages,
  estimateTokensFromText,
  logCost,
} from '../services/cost-logger';
import { resolveModelRoute } from '../catalog';
import { getProvider } from '../providers';
import { logRequestDump } from '../services/request-dump-logger';
import {
  formatUpstreamError,
  logOutgoing,
  logProxyError,
  logResponse,
  truncateMiddle,
} from '../services/request-logger';
import { isGarbage, analyzeText } from './garbage-detector';
import { trackUpstreamHeaders } from './rate-limit-tracker';
import { logRateLimit } from './rate-limit-logger';
import {
  acquireSlot,
  acquireAliasGroupSlot,
  buildAliasGroupSpecs,
  resolveConcurrentLimit,
  isTooManyConcurrentRequests,
  recordModelResponse,
  recordRequestStart,
  recordRequestEnd,
  recordIncomingStart,
  recordIncomingEnd,
  registerReapable,
  unregisterReapable,
  startZombieReaper,
  type AliasGroupSpec,
} from './concurrency-queue';
import { allProviders } from '../providers';
import {
  messageInputModalities,
  unsupportedInputModalities,
  resolveModelCapabilities,
} from '../model-capabilities';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'host',
  'content-length',
]);

const OVERWHELMED_MESSAGE =
  'I am a bit overwhelmed. Let me take a deep breath and continue.';

/**
 * Thrown by 429 handlers when the upstream rejects with
 * "too many concurrent requests" and there are still deferrals left
 * (RETRY_LOOP_COUNTER). The concurrency-queue loop in
 * forwardChatCompletion catches it and re-queues.
 */
class QueueRetry429 extends Error {}

function forwardHeaders(
  incoming: IncomingHttpHeaders,
  apiKey: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!value || HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (apiKey) {
    out.authorization = `Bearer ${apiKey}`;
  }
  out['content-type'] = 'application/json';
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}

interface UsageBreakdown {
  usage: TokenUsage;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

function parseUsage(payload: unknown): UsageBreakdown | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as { usage?: Record<string, unknown> }).usage;
  if (!raw) return null;

  const prompt = Number(raw.prompt_tokens ?? 0);
  const completion = Number(raw.completion_tokens ?? 0);
  if (!prompt && !completion) return null;

  const cacheHitTokens = Number(raw.prompt_cache_hit_tokens ?? 0);
  const cacheMissTokens = Number(raw.prompt_cache_miss_tokens ?? 0);

  return {
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: Number(raw.total_tokens ?? prompt + completion),
    },
    cacheHitTokens,
    cacheMissTokens,
  };
}

function computeBilledCost(
  adapter: ProviderAdapter,
  model: string,
  breakdown: UsageBreakdown | null,
  promptEstimate: number,
  completionText: string,
): { tokensIn: number; tokensOut: number; dollars: number } {
  const pricing = adapter.getPricing(model);
  const inputRate =
    pricing.inputPerMillion ?? appConfig.fallbackPricing.inputPerMillion;
  const outputRate =
    pricing.outputPerMillion ?? appConfig.fallbackPricing.outputPerMillion;
  const cacheRate = pricing.cacheReadPerMillion ?? 0;

  const tokensIn = breakdown?.usage.prompt_tokens ?? promptEstimate;
  const tokensOut =
    breakdown?.usage.completion_tokens ??
    estimateTokensFromText(completionText);

  const hasCacheSplit =
    breakdown &&
    cacheRate > 0 &&
    (breakdown.cacheHitTokens > 0 || breakdown.cacheMissTokens > 0);

  const dollars = hasCacheSplit
    ? computeCost(
        breakdown.cacheMissTokens,
        tokensOut,
        inputRate,
        outputRate,
        breakdown.cacheHitTokens,
        cacheRate,
      )
    : computeCost(tokensIn, tokensOut, inputRate, outputRate);

  return { tokensIn, tokensOut, dollars };
}

function describeForwardError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const parts = [err.message];
    if (err.code) parts.push(`code=${err.code}`);
    if (err.response) {
      parts.push(`status=${err.response.status}`);
      const detail = formatUpstreamError(
        err.response.status,
        err.response.data,
      );
      if (detail) parts.push(detail);
    }
    return parts.join(' | ');
  }
  return err instanceof Error ? err.message : 'Upstream request failed';
}

function forEachSseDataLine(
  chunk: string,
  onData: (parsed: unknown) => void,
): void {
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      onData(JSON.parse(data));
    } catch {
      // ignore malformed SSE chunks
    }
  }
}

function extractStreamText(chunk: string): string {
  let text = '';
  forEachSseDataLine(chunk, (parsed) => {
    const choices = (
      parsed as { choices?: Array<{ delta?: { content?: string } }> }
    ).choices;
    for (const choice of choices ?? []) {
      text += choice.delta?.content ?? '';
    }
  });
  return text;
}

function collectStreamUsage(
  chunk: string,
  current: UsageBreakdown | null,
): UsageBreakdown | null {
  let latest = current;
  forEachSseDataLine(chunk, (parsed) => {
    const usage = parseUsage(parsed);
    if (usage) latest = usage;
  });
  return latest;
}

/** Ask upstream to emit usage in the final stream chunk (DeepSeek cache billing). */
function withStreamUsage(body: ChatCompletionRequest): ChatCompletionRequest {
  if (!body.stream) return body;
  const existing = body.stream_options;
  if (
    existing &&
    typeof existing === 'object' &&
    (existing as { include_usage?: boolean }).include_usage
  ) {
    return body;
  }
  return {
    ...body,
    stream_options: {
      ...(existing && typeof existing === 'object' ? existing : {}),
      include_usage: true,
    },
  };
}

/** Build throughput metrics for a completed model reply (successful only). */
function throughputMetrics(
  startedAt: number,
  text: string,
  tokensOut?: number,
): { durationMs: number; bytes: number; tokensOut?: number } {
  return {
    durationMs: Date.now() - startedAt,
    bytes: Buffer.byteLength(text || ''),
    tokensOut,
  };
}

async function recordUsage(
  adapter: ProviderAdapter,
  model: string,
  breakdown: UsageBreakdown | null,
  promptEstimate: number,
  completionText: string,
  requestCtx: CompletionRequestContext,
  opts: {
    requestBody: ChatCompletionRequest;
    upstreamUrl: string;
    status: number;
    stream: boolean;
    responseBody: unknown;
    error?: string;
  },
): Promise<void> {
  const { tokensIn, tokensOut, dollars } = computeBilledCost(
    adapter,
    model,
    breakdown,
    promptEstimate,
    completionText,
  );

  await logCost({
    model,
    tokensIn,
    tokensOut,
    dollars,
    provider: adapter.id,
    userRequestPreview: requestCtx.userRequestPreview,
    requestKb: requestCtx.requestKb,
  });

  await logRequestDump({
    provider: adapter.id,
    model,
    upstreamUrl: opts.upstreamUrl,
    status: opts.status,
    stream: opts.stream,
    tokensIn,
    tokensOut,
    dollars,
    requestBody: opts.requestBody,
    responseBody: opts.responseBody,
    requestCtx,
    error: opts.error,
  });
}

/**
 * Send a graceful "overwhelmed" non-streaming JSON response.
 * Used as a fallback when the fallback chain is exhausted and the
 * original model returned garbage.
 */
function sendOverwhelmedResponse(res: Response, model: string): void {
  res.status(200).json({
    id: `chatcmpl-overwhelmed-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: OVERWHELMED_MESSAGE,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
}

/**
 * Attempt a single streaming request to upstream, buffering the full output.
 * Returns the full completion text, usage breakdown, collected chunks, HTTP status,
 * and the raw upstream response object.
 */
async function bufferedStreamRequest(
  url: string,
  payload: ChatCompletionRequest,
  headers: Record<string, string>,
): Promise<{
  completionText: string;
  streamUsage: UsageBreakdown | null;
  chunks: Buffer[];
  status: number;
  upstreamHeaders: Record<string, string>;
  rawErrorBody: string;
}> {
  const upstream = await resilientPost<NodeJS.ReadableStream>(url, payload, {
    headers,
    responseType: 'stream',
    validateStatus: () => true,
  });

  const upstreamFailed = upstream.status >= 400;
  const upstreamHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (value && !HOP_BY_HOP.has(key.toLowerCase())) {
      upstreamHeaders[key] = value as string;
    }
  }

  let completionText = '';
  let rawErrorBody = '';
  let streamUsage: UsageBreakdown | null = null;
  const chunks: Buffer[] = [];

  // For error responses, don't wait for stream end — close after 5s max
  if (upstreamFailed) {
    await new Promise<void>((resolve) => {
      const stream = upstream.data as NodeJS.ReadableStream & { destroy?: () => void };
      const timer = setTimeout(() => { stream.destroy?.(); resolve(); }, 5000);
      stream.on('data', (chunk: Buffer) => { rawErrorBody += chunk.toString('utf8'); });
      stream.on('end', () => { clearTimeout(timer); resolve(); });
      stream.on('error', () => { clearTimeout(timer); stream.destroy?.(); resolve(); });
    });
  } else {
    // Success stream: timeout at 300s (5 min) to prevent hung connections
    const STREAM_TIMEOUT_MS = 300_000;
    await new Promise<void>((resolve, reject) => {
      const stream = upstream.data as NodeJS.ReadableStream & { destroy?: () => void };
      let timer = setTimeout(() => {
        stream.destroy?.();
        reject(new Error(`stream timeout after ${STREAM_TIMEOUT_MS / 1000}s`));
      }, STREAM_TIMEOUT_MS);
      stream.on('data', (chunk: Buffer) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          stream.destroy?.();
          reject(new Error(`stream timeout after ${STREAM_TIMEOUT_MS / 1000}s`));
        }, STREAM_TIMEOUT_MS);
        chunks.push(chunk);
        const text = chunk.toString('utf8');
        completionText += extractStreamText(text);
        streamUsage = collectStreamUsage(text, streamUsage);
      });
      stream.on('end', () => {
        clearTimeout(timer);
        stream.destroy?.();
        resolve();
      });
      stream.on('error', (err) => {
        clearTimeout(timer);
        stream.destroy?.();
        reject(err);
      });
    });
  }

  return {
    completionText,
    streamUsage,
    chunks,
    status: upstream.status,
    upstreamHeaders,
    rawErrorBody,
  };
}

/**
 * Forward the pre-collected chunks to the client as-is (SSE streaming).
 */
function flushBufferedChunks(
  res: Response,
  chunks: Buffer[],
  upstreamStatus: number,
  upstreamHeaders: Record<string, string>,
  onDone?: () => void,
): void {
  if (!res.headersSent) {
    res.status(upstreamStatus);
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    for (const [key, value] of Object.entries(upstreamHeaders)) {
      res.setHeader(key, value);
    }
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
  }
  for (const chunk of chunks) {
    res.write(chunk);
  }
  res.end();
  onDone?.();
}

/**
 * Try the configured fallback chain.
 *
 * For aliased models (e.g. "kimi" → gonka/Kimi → gonka/MiniMax → deepseek/v4):
 *   the alias's chain is used. Each entry is tried in order.
 *
 * For direct models (e.g. "gonka/Kimi-K2.6" used directly, no alias):
 *   chain is empty → no fallback → returns false → caller sends error.
 *
 * Any failure reason (network error, rate-limit, garbage) follows the same
 * path through this function.
 */
async function tryFallbackChain(
  label: string,
  originalAdapter: ProviderAdapter,
  originalModel: string,
  body: ChatCompletionRequest,
  incomingHeaders: IncomingHttpHeaders,
  res: Response,
  endpointPrefix: string,
  skipGroupMembers: string[] = [],
): Promise<boolean> {
  // Find the alias chain for the requested model
  let chain: string[] | undefined;
  const requestedModel = body.model as string | undefined;
  if (requestedModel && appConfig.modelAliases) {
    chain = appConfig.modelAliases.get(requestedModel);
  }
  // Fall back to global MODEL_FALLBACK_CHAIN
  if (!chain || !chain.length) {
    chain = appConfig.modelFallbackChain;
  }
  if (!chain.length) return false;

  // Find current model's index in chain, start from next
  let startIndex = 0;
  for (let si = 0; si < chain.length; si++) {
    const sr = await resolveModelRoute(chain[si]);
    if (
      sr &&
      sr.provider === originalAdapter.id &&
      sr.upstreamModel === originalModel
    ) {
      startIndex = si + 1;
      break;
    }
  }

  for (let i = startIndex; i < chain.length; i++) {
    const alias = chain[i];
    const route = await resolveModelRoute(alias);
    if (!route) {
      console.warn(
        `[fallback] could not resolve "${alias}" in chain — skipping`,
      );
      continue;
    }

    // Skip models that already failed inside the preferred group pool.
    if (route && skipGroupMembers.includes(`${route.provider}:${route.upstreamModel}`)) {
      console.log(
        `[fallback] skipping ${route.provider}/${route.upstreamModel} (member already exhausted in group)`,
      );
      continue;
    }

    // Don't fallback to self (handled by startIndex, kept as safety)
    if (
      route.provider === originalAdapter.id &&
      route.upstreamModel === originalModel
    ) {
      continue;
    }

    const requestedModelName = String(body.model ?? '');

    // Skip this chain entry if the payload is incompatible with the model
    // (e.g. images in history but target model is text-only).
    if (!isModelCompatible(body, route.provider, route.upstreamModel)) {
      logProxyError({
        provider: route.provider,
        endpointPrefix,
        requestedModel: requestedModelName,
        effectiveModel: route.upstreamModel,
        message: `skipping fallback chain[${i}] - incompatible with model capabilities`,
      });
      continue;
    }

    console.log(
      `[fallback] ${requestedModelName} | ${originalAdapter.id}/${originalModel} → ${route.provider}/${route.upstreamModel} | reason: ${label}`,
    );
    logProxyError({
      provider: originalAdapter.id,
      endpointPrefix,
      requestedModel: requestedModelName,
      effectiveModel: originalModel,
      message: `${label}, falling back to ${route.provider}/${route.upstreamModel} (chain[${i}])`,
    });

    try {
      await forwardChatCompletion(
        getProvider(route.provider),
        route.upstreamModel,
        body,
        incomingHeaders,
        res,
        endpointPrefix,
        originalModel,
      );
      return true; // succeeded
    } catch {
      // This fallback also failed — try next in chain
      logProxyError({
        provider: route.provider,
        endpointPrefix,
        requestedModel: requestedModelName,
        effectiveModel: route.upstreamModel,
        message: `fallback chain[${i}] also failed, trying next`,
      });
    }
  }

  return false; // all fallbacks exhausted
}

type ChatMessage = { role: string; content: string | unknown };

/**
 * Strip empty tool_calls arrays from assistant messages.
 * Some upstream APIs (Gonka) reject messages with tool_calls: [].
 */
function sanitizeEmptyToolCalls(
  messages: ChatMessage[] | undefined,
): ChatMessage[] | undefined {
  if (!messages || messages.length === 0) return messages;

  let changed = false;
  const cleaned = messages.map((m) => {
    if (
      m.role === 'assistant' &&
      Array.isArray((m as Record<string, unknown>).tool_calls) &&
      ((m as Record<string, unknown>).tool_calls as unknown[]).length === 0
    ) {
      changed = true;
      const { tool_calls: _, ...rest } = m as Record<string, unknown>;
      return rest as ChatMessage;
    }
    return m;
  });

  return changed ? cleaned : messages;
}

function applyPromptOverrides(
  messages: ChatMessage[] | undefined,
): ChatMessage[] | undefined {
  if (!messages || messages.length === 0) return messages;

  const prefix = appConfig.systemPrompt;
  const suffix = appConfig.systemPromptSuffix;
  if (!prefix && !suffix) return messages;

  const cloned = messages.map((m) => ({ ...m }));

  // Prepend to the system message (create one if none exists)
  if (prefix) {
    const sysIdx = cloned.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0) {
      const prev =
        typeof cloned[sysIdx].content === 'string'
          ? cloned[sysIdx].content
          : '';
      cloned[sysIdx] = {
        ...cloned[sysIdx],
        content: prefix + '\n\n' + (prev as string),
      };
    } else {
      // Insert system message at the beginning
      cloned.unshift({ role: 'system', content: prefix });
    }
  }

  // Append to the last user message
  if (suffix) {
    for (let i = cloned.length - 1; i >= 0; i--) {
      if (cloned[i].role === 'user') {
        const prev =
          typeof cloned[i].content === 'string' ? cloned[i].content : '';
        cloned[i] = {
          ...cloned[i],
          content: (prev as string) + '\n\n' + suffix,
        };
        break;
      }
    }
  }

  return cloned;
}

function sanitizeProviderParams(
  providerId: ProviderId,
  payload: ChatCompletionRequest,
  adapter: ProviderAdapter,
): ChatCompletionRequest {
  let cleaned = payload;

  // Strip unsupported params from provider quirks (e.g. groq: ['reasoning_effort'])
  const knownUnsupported: Record<string, string[]> = {
    groq: ['reasoning_effort'],
    hyperfusion: ['reasoning_effort'],
  };
  const strip = knownUnsupported[providerId];
  if (strip && strip.length > 0) {
    let changed = false;
    const patched = { ...cleaned };
    for (const key of strip) {
      if (key in patched) {
        delete (patched as Record<string, unknown>)[key];
        changed = true;
      }
    }
    if (changed) cleaned = patched;
  }

  // Cap max_tokens to model's actual output limit (Groq via adapter capability)
  if (providerId === 'groq' && typeof cleaned.max_tokens === 'number') {
    const groqAdapter = adapter as import('../providers/base').GroqProvider;
    if ('getModelMaxTokens' in groqAdapter) {
      const modelCap = groqAdapter.getModelMaxTokens(payload.model as string);
      if (modelCap && cleaned.max_tokens > modelCap) {
        cleaned = { ...cleaned, max_tokens: modelCap };
      }
    }
  }

  return cleaned;
}

/** Models whose reasoning_content must be preserved for round-trip. */
function isMoonshotReasoningModel(providerId: string, model: string): boolean {
  if (providerId !== 'gonka' && providerId !== 'gonka-dahl' && providerId !== 'gonka-api' && providerId !== 'joingonka' && providerId !== 'gonka-mingles' && providerId !== 'gonka-router-io' && providerId !== 'gonkabroker' && providerId !== 'hyperfusion') return false;
  const lower = model.toLowerCase();
  return (
    lower.includes('moonshotai/kimi') ||
    /^kimi-?k?2?\.?6$/i.test(lower)
  );
}

/** Providers behind the gonka gateway(s) — they validate content as arrays of blocks. */
function isGonkaFamilyProvider(providerId: string): boolean {
  return /gonka/i.test(providerId);
}

/**
 * Normalize message `content` to the array-of-blocks form the gonka gateway
 * requires (`messages[].content` must be a non-empty array of `{type,text}`).
 * - string content → `[{ type: 'text', text: ... }]`
 * - assistant messages that only carry tool_calls (empty string/empty array
 *   content) → drop the `content` field entirely (OpenAI convention)
 */
function normalizeContentBlocks(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const out = messages.map((m): ChatMessage => {
    if (!m || typeof m.content === 'undefined' || m.content === null) return m;
    const c = m.content as unknown;
    if (typeof c === 'string') {
      changed = true;
      if (m.role === 'assistant' && c.trim() === '') {
        const { content: _drop, ...rest } = m as Record<string, unknown>;
        return rest as ChatMessage;
      }
      return { ...m, content: [{ type: 'text', text: c }] } as ChatMessage;
    }
    if (Array.isArray(c) && c.length === 0) {
      changed = true;
      if (m.role === 'assistant') {
        const { content: _drop, ...rest } = m as Record<string, unknown>;
        return rest as ChatMessage;
      }
      return { ...m, content: [{ type: 'text', text: '' }] } as ChatMessage;
    }
    return m;
  });
  return changed ? out : messages;
}

/**
 * MiniMax S2/agentic tool calls arrive as XML embedded in assistant `content`
 * (no `tool_calls` array), e.g.:
 *
 *   <minimax:tool_call>
 *     <invoke name="terminal"><parameter name="command">ls</parameter></invoke>
 *   </minimax:tool_call>
 *
 * Convert any such block into standard OpenAI `tool_calls`, strip the XML from
 * content, and set finish_reason to "tool_calls", so Hermes can execute it.
 */
const MINIMAX_TOOLCALL_XML_RE = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/g;
const MINIMAX_INVOKE_RE = /<invoke\s+name=["']([^"']+)\s*["']>([\s\S]*?)<\/invoke>/g;
const MINIMAX_PARAM_RE = /<parameter\s+name=["']([^"']+)\s*["']>([\s\S]*?)<\/parameter>/g;

function unescapeXml(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Extract MiniMax `<invoke>` tool calls from content, or null if none present. */
function parseMiniMaxToolCalls(content: string): Array<{ name: string; args: Record<string, string> }> | null {
  if (content.indexOf('<invoke') === -1 && content.indexOf('minimax:tool_call') === -1) return null;
  const blocks = content.match(MINIMAX_TOOLCALL_XML_RE);
  const calls: Array<{ name: string; args: Record<string, string> }> = [];
  const sources = blocks && blocks.length ? blocks : (content.includes('<invoke') ? [content] : []);
  for (const block of sources) {
    let m: RegExpExecArray | null;
    const invoke = new RegExp(MINIMAX_INVOKE_RE.source, MINIMAX_INVOKE_RE.flags);
    while ((m = invoke.exec(block))) {
      const name = m[1].trim();
      const inner = m[2];
      const args: Record<string, string> = {};
      const param = new RegExp(MINIMAX_PARAM_RE.source, MINIMAX_PARAM_RE.flags);
      let p: RegExpExecArray | null;
      while ((p = param.exec(inner))) {
        args[p[1].trim()] = unescapeXml(p[2].trim());
      }
      calls.push({ name, args });
    }
  }
  return calls.length ? calls : null;
}

/** In-place convert the assistant message into standard tool_calls if it carries MiniMax XML. */
function convertMiniMaxAgenticToolCall(body: unknown): unknown {
  const root = body as { choices?: Array<{ message?: { role?: string; content?: unknown; tool_calls?: unknown }; finish_reason?: string }> };
  if (!root || !Array.isArray(root.choices)) return body;
  let converted = false;
  for (const choice of root.choices) {
    const msg = choice?.message;
    if (!msg || msg.role !== 'assistant') continue;
    if (Array.isArray(msg.tool_calls) && (msg.tool_calls as unknown[]).length > 0) continue;
    if (typeof msg.content !== 'string') continue;
    const calls = parseMiniMaxToolCalls(msg.content as string);
    if (!calls) continue;
    // Strip the XML tool-call block(s) from content, collapse leftover blank lines.
    msg.content = (msg.content as string)
      .replace(MINIMAX_TOOLCALL_XML_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    msg.tool_calls = calls.map((c, i) => ({
      id: `call_minimax_${i}_${c.name.replace(/[^A-Za-z0-9_-]/g, '_')}`,
      type: 'function',
      function: {
        name: c.name,
        arguments: JSON.stringify(c.args),
      },
    }));
    if (choice.finish_reason && choice.finish_reason !== 'length') {
      choice.finish_reason = 'tool_calls';
    }
    converted = true;
  }
  return body;
}

/** True when the effective model string looks like a MiniMax (M2/agentic) model. */
export function isMiniMaxModel(model: string): boolean {
  return /minimax/i.test(model);
}

/** Serialize an OpenAI-style SSE `data:` frame. */
function sseFrame(obj: unknown): Buffer {
  return Buffer.from(`data: ${JSON.stringify(obj)}\n\n`, 'utf8');
}

/**
 * A MiniMax M2 / agentic stream has the SAME problem as the non-streaming
 * responder: tool calls arrive as `<minimax:tool_call>` XML embedded in the
 * assistant `content` delta instead of an OpenAI `tool_calls` array. The
 * gonka streaming path buffers the whole SSE body (for garbage detection), so
 * here we re-synthesize those buffered chunks into an OpenAI-compatible
 * stream carrying proper `tool_calls` + `finish_reason:"tool_calls"`.
 *
 * If no MiniMax XML is present, the original chunks are returned untouched so
 * normal streams keep their exact byte-for-byte forwarding (no latency cost).
 */
export function rewriteStreamForMiniMax(
  chunks: Buffer[],
  completionText: string,
  model: string,
): Buffer[] {
  // Only touch MiniMax-style responses: either the effective model is MiniMax,
  // or the content explicitly carries the `<minimax:tool_call>` marker (covers
  // aliases whose string doesn't include "minimax").
  const hasMiniMaxXml =
    isMiniMaxModel(model) ||
    completionText.indexOf('minimax:tool_call') !== -1;
  if (!hasMiniMaxXml) return chunks;
  if (completionText.indexOf('<invoke') === -1 && completionText.indexOf('minimax:tool_call') === -1) {
    return chunks;
  }

  const calls = parseMiniMaxToolCalls(completionText);
  if (!calls) return chunks;

  // Strip the XML block(s) from the narration, mirroring the non-streaming
  // converter (collapse leftover blank lines, trim).
  const narration = (completionText as string)
    .replace(MINIMAX_TOOLCALL_XML_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const created = Math.floor(Date.now() / 1000);
  const out: Buffer[] = [];

  // 1) Role + narration delta.
  out.push(
    sseFrame({
      id: 'chatcmpl-minimax-proxy',
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: narration },
          finish_reason: null,
        },
      ],
    }),
  );

  // 2) One delta carrying the full tool_calls array.
  out.push(
    sseFrame({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((c, i) => ({
              index: i,
              id: `call_minimax_${i}_${c.name.replace(/[^A-Za-z0-9_-]/g, '_')}`,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          finish_reason: null,
        },
      ],
    }),
  );

  // 3) Final finish_reason frame.
  out.push(
    sseFrame({
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    }),
  );

  // Preserve the upstream usage frame when stream_options.include_usage was set
  // (upstream emits it as a final `choices: []` data frame).
  const joined = Buffer.concat(chunks).toString('utf8');
  for (const line of joined.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as {
        usage?: unknown;
        choices?: unknown[];
      };
      if (parsed.usage && Array.isArray(parsed.choices) && parsed.choices.length === 0) {
        out.push(Buffer.from(`data: ${data}\n\n`, 'utf8'));
        break;
      }
    } catch {
      // ignore malformed SSE lines
    }
  }

  out.push(Buffer.from('data: [DONE]\n\n', 'utf8'));
  return out;
}

/**
 * Isolate a per-attempt copy of the request, adapted for a specific target
 * model. The original `body` is NEVER mutated — each fallback step starts
 * from the pristine client payload.
 *
 * Adaptations:
 *  - strip `reasoning_content` from assistant messages for any model that is
 *    NOT Moonshot/Kimi (DeepSeek/MiniMax reject foreign reasoning_content);
 *  - leave `reasoning_content` in place for Moonshot Kimi (needs round-trip);
 *  - apply existing prompt overrides + empty-tool_calls sanitization.
 */
function adaptForModel(
  body: ChatCompletionRequest,
  providerId: ProviderId,
  model: string,
  modelQuirks?: Record<string, ModelQuirkOverrides>,
): ChatCompletionRequest {
  let messages = applyPromptOverrides(body.messages);
  messages = sanitizeEmptyToolCalls(messages);

  // gonka gateway requires content as a non-empty array of {type,text} blocks.
  if (isGonkaFamilyProvider(providerId) && messages) {
    messages = normalizeContentBlocks(messages);
  }

  if (!isMoonshotReasoningModel(providerId, model)) {
    let stripped = 0;
    const cleaned = (messages ?? []).map((m) => {
      if (
        m.role === 'assistant' &&
        Object.prototype.hasOwnProperty.call(m, 'reasoning_content')
      ) {
        stripped++;
        const { reasoning_content: _, ...rest } = m as Record<string, unknown>;
        return rest as ChatMessage;
      }
      return m;
    });
    if (stripped > 0) {
      console.log(
        `[sanitize] stripped reasoning_content from ${stripped} assistant message(s) for ${providerId}/${model}`,
      );
      messages = cleaned;
    }
  }

  let adapted: ChatCompletionRequest =
    messages !== body.messages ? { ...body, messages } : { ...body };

  adapted = sanitizeProviderParams(providerId, adapted, getProvider(providerId as ProviderId));

  // Apply per-model reasoning_effort override from model-metadata.json
  // (e.g. MiniMax inlines <think> in content — lower effort saves output tokens)
  const quirk = modelQuirks?.[model];
  if (quirk?.reasoningEffort) {
    adapted = { ...adapted, reasoning_effort: quirk.reasoningEffort };
  }

  return adapted;
}

/**
 * Check whether a fallback candidate can accept the client payload.
 * If not (e.g. vision content in history but the target model is text-only),
 * we skip this chain entry instead of failing the whole request.
 */
function isModelCompatible(
  body: ChatCompletionRequest,
  providerId: string,
  model: string,
): boolean {
  const requested = messageInputModalities(body.messages);
  if (requested.size === 0) return true;

  const capabilities = resolveModelCapabilities(
    providerId as ProviderId,
    model,
  );
  const blocked = unsupportedInputModalities(capabilities, requested);
  if (blocked.length > 0) {
    console.log(
      `[fallback] skipping ${providerId}/${model}: incompatible input modalities: ${blocked.join(', ')}`,
    );
    return false;
  }
  return true;
}

/**
 * Throw QueueRetry429 when a re-queue attempt is still available and the
 * current model has a CONCURRENT limit + the upstream 429 body is the
 * "too many concurrent requests" variant. The outer queue loop catches this
 * and re-queues (up to RETRY_LOOP_COUNTER tries). When attempts are
 * exhausted, no throw happens and the normal 429 fallback/passthrough runs.
 */
function throwIfTooManyConcurrent(
  adapter: ProviderAdapter,
  model: string,
  rawBody: unknown,
  canRetry: boolean,
): void {
  const limit = resolveConcurrentLimit(adapter, model);
  if (canRetry && limit !== undefined && isTooManyConcurrentRequests(rawBody)) {
    throw new QueueRetry429();
  }
}

export async function forwardChatCompletion(
  adapter: ProviderAdapter,
  activeModel: string,
  body: ChatCompletionRequest,
  incomingHeaders: IncomingHttpHeaders,
  res: Response,
  endpointPrefix: string,
  /** Model that was originally failing (set when called from tryFallbackChain) */
  fallbackFrom?: string,
): Promise<void> {
  const model = activeModel.trim() || adapter.resolveModel(body.model);
  const limit = resolveConcurrentLimit(adapter, model);
  const queueKey = `${adapter.id}:${model}`;
  // Build alias group specs from alias config
  const aliasName = String(body.model ?? '');
  const groups = aliasName ? buildAliasGroupSpecs(getAliasGroups(aliasName) ?? [], allProviders(), aliasName) : [];
  const groupExhausted = new Set<string>();
  let attemptsLeft = appConfig.retryLoopCounter;
  let groupIdx = 0;

  // Track incoming connection for dashboard
  const incPreview = (() => {
    const msgs = body.messages ?? [];
    const lastUser = [...msgs].reverse().find((m: any) => m.role === 'user');
    return typeof lastUser?.content === 'string' ? lastUser.content.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  })();
  const incId = recordIncomingStart(incPreview);
  const markIncomingDone = () => recordIncomingEnd(incId);
  // Reaper: kill incoming connection if client stream hangs > limit
  registerReapable({ id: incId, kind: 'incoming', startedAt: Date.now(), destroy: () => res.destroy?.() });
  const doneIncoming = () => { unregisterReapable(incId); markIncomingDone(); };
  // Safety net: guaranteed cleanup when response fully sent to client
  res.on('finish', doneIncoming);

  // Preview for queue dashboard: last user message, ~60 chars
  const userMsg = (body.messages ?? [])
    .filter((m: any) => m.role === 'user')
    .pop();
  const queuePreview: string =
    typeof userMsg?.content === 'string'
      ? userMsg.content.replace(/\s+/g, ' ').trim().slice(0, 60)
      : '';

  while (true) {
    const waitMs = appConfig.retryQueueWaitTimeout * 1000;

    // Iterate alias groups in order
    if (groupIdx < groups.length) {
      const g = groups[groupIdx];
      const gAcquired = await acquireAliasGroupSlot(g, waitMs, () => res.writableEnded || res.destroyed, queuePreview);
      
      if (gAcquired.ok) {
        const grpAdapter = getProvider(gAcquired.provider as ProviderId);
        const { release } = gAcquired.handle;
        try {
          await forwardChatCompletionOnce(grpAdapter, gAcquired.model, body, incomingHeaders, res, endpointPrefix, fallbackFrom, attemptsLeft > 0, doneIncoming);
          return;
        } catch (err) {
          if (err instanceof QueueRetry429 && attemptsLeft > 0) { attemptsLeft--; continue; }
          release();
          groupExhausted.add(`${gAcquired.provider}:${gAcquired.model}`);
          continue;
        } finally {
          release();
        }
      }
      
      if (gAcquired.reason === 'timeout' || gAcquired.reason === 'all-busy') { groupIdx++; continue; }
      if (gAcquired.reason === 'client-closed') return;
    }

    // All alias groups exhausted — fall back through flat chain
    if (groupIdx >= groups.length && groups.length > 0) {
      const rerouted = await tryFallbackChain('alias-groups-exhausted', adapter, model, body, incomingHeaders, res, endpointPrefix, [...groupExhausted]);
      if (rerouted) return;
      if (!res.headersSent) {
        res.status(429).json({ error: { message: 'All alias groups exhausted', type: 'proxy_error' } });
      }
      return;
    }

    // Per-model concurrency slot
    const acquired = await acquireSlot(
      queueKey,
      limit ?? 0,
      waitMs,
      () => res.writableEnded || res.destroyed,
      queuePreview,
    );

    if (!acquired.ok) {
      if (acquired.reason === 'client-closed') return;
      const rerouted = await tryFallbackChain(
        'queue-timeout',
        adapter,
        model,
        body,
        incomingHeaders,
        res,
        endpointPrefix,
      );
      if (!rerouted && !res.headersSent) {
        res.status(429).json({ error: { message: 'Request queue timeout', type: 'rate_limit_error' } });
      }
      return;
    }

    const { release } = acquired.handle;
    try {
      await forwardChatCompletionOnce(
        adapter,
        model,
        body,
        incomingHeaders,
        res,
        endpointPrefix,
        fallbackFrom,
        attemptsLeft > 0,
        markIncomingDone,
      );
      return;
    } catch (err) {
      if (err instanceof QueueRetry429 && attemptsLeft > 0) {
        attemptsLeft--;
        console.log(`[queue] ${queueKey} upstream 429 "too many concurrent requests", re-queuing (${attemptsLeft} left)`);
        continue;
      }
      throw err;
    } finally {
      release();
    }
  }
}

async function forwardChatCompletionOnce(
  adapter: ProviderAdapter,
  activeModel: string,
  body: ChatCompletionRequest,
  incomingHeaders: IncomingHttpHeaders,
  res: Response,
  endpointPrefix: string,
  /** Model that was originally failing (set when called from tryFallbackChain) */
  fallbackFrom?: string,
  /** Whether a QueueRetry429 re-queue is still available (RETRY_LOOP_COUNTER). */
  canRetry = true,
  markIncomingDone?: () => void,
): Promise<void> {
  const model = activeModel.trim() || adapter.resolveModel(body.model);
  const requestCtx = captureRequestContext(body.messages);
  const promptEstimate = estimateTokensFromMessages(body.messages);
  const url = adapter.chatCompletionsUrl();
  const headers = forwardHeaders(
    incomingHeaders,
    adapter.config.apiKey,
    adapter.config.extraHeaders,
  );
  const streaming = Boolean(body.stream);

  // Track live request for dashboard
  const reqId = recordRequestStart(
    `${adapter.id}:${model}`, adapter.id, model,
    requestCtx.userRequestPreview,
  );
  // Reaper: kill upstream stream if it hangs > limit
  const reqStartedAt = Date.now();
  const outboundAbort = { aborted: false };
  registerReapable({ id: reqId, kind: 'outgoing', startedAt: reqStartedAt, destroy: () => { outboundAbort.aborted = true; (res as any).__abortOutbound?.(); } });

  // Isolate a per-attempt copy of the request adapted for this model.
  // The original `body` is never mutated — every fallback step starts
  // from the pristine client payload (covers reasoning_content stripping,
  // prompt overrides, empty tool_calls, and provider param quirks).
  const adaptedBody = adaptForModel(body, adapter.id, model, adapter.config.modelQuirks);
  const patchedPayload: ChatCompletionRequest = withStreamUsage({
    ...adaptedBody,
    model,
  });

  const requestedModelName = String(body.model ?? '');

  logOutgoing({
    provider: adapter.id,
    url,
    stream: streaming,
    endpointPrefix,
    requestedModel: requestedModelName,
    effectiveModel: model,
  });

  // === Streaming path ===
  if (body.stream) {
    // Gonka streaming: buffer, detect garbage, fallback on garbage (same as any error)
    if (adapter.id === 'gonka' || adapter.id === 'gonka-dahl' || adapter.id === 'gonka-api' || adapter.id === 'joingonka' || adapter.id === 'gonka-mingles' || adapter.id === 'gonka-router-io' || adapter.id === 'gonkabroker' || adapter.id === 'hyperfusion') {
      await forwardStreamWithGarbageProtection(
        adapter,
        model,
        patchedPayload,
        headers,
        url,
        body,
        requestCtx,
        promptEstimate,
        res,
        incomingHeaders,
        endpointPrefix,
        reqStartedAt,
        fallbackFrom,
        canRetry,
        reqId,
        markIncomingDone,
      );
      return;
    }

    // Non-gonka streaming: forward directly
    let completionText = '';
    let rawErrorBody = '';
    let streamUsage: UsageBreakdown | null = null;
    let upstream: AxiosResponse<NodeJS.ReadableStream> | null = null;

    try {
      upstream = await resilientPost<NodeJS.ReadableStream>(
        url,
        patchedPayload,
        {
          headers,
          responseType: 'stream',
          validateStatus: () => true,
        },
      );
      const upstreamStatus = upstream.status;
      const upstreamFailed = upstreamStatus >= 400;

      // Track live rate-limit headers from upstream
      trackUpstreamHeaders(
        adapter.id,
        upstream.headers as Record<string, string>,
      );

      // Rate-limit fallback: 429 or 413 (TPM exceeded) → drain body, dump, reroute
      if (upstreamStatus === 429 || upstreamStatus === 413) {
        // Drain the error stream body fully before falling back
        let errorBody = '';
        await new Promise<void>((resolve) => {
          upstream!.data.on('data', (chunk: Buffer) => {
            errorBody += chunk.toString('utf8');
          });
          upstream!.data.on('end', resolve);
          upstream!.data.on('error', resolve);
          // Also resolve after a short timeout in case of stuck connection
          setTimeout(resolve, 2000);
        });
        const upstreamRlHeaders = (upstream?.headers ?? {}) as Record<string, string>;
        (
          upstream.data as NodeJS.ReadableStream & { destroy?: () => void }
        ).destroy?.();
        upstream = null;

        // Dump full request + upstream error response before falling back
        const parsedError = (() => {
          try {
            return JSON.parse(errorBody);
          } catch {
            return errorBody;
          }
        })();
        const errorDetail = formatUpstreamError(upstreamStatus, parsedError);

        recordRequestEnd(reqId, upstreamStatus, errorDetail);

        await logRequestDump({
          provider: adapter.id,
          model,
          upstreamUrl: url,
          status: upstreamStatus,
          stream: true,
          tokensIn: 0,
          tokensOut: 0,
          dollars: 0,
          requestBody: body,
          responseBody: parsedError,
          requestCtx,
          error: `rate-limited:${upstreamStatus} | ${errorDetail}`,
        }).catch((err) => {
          console.error('[request-dump] logRequestDump failed:', (err as Error)?.message ?? String(err));
        });

        // Diagnostic: capture raw rate-limit headers/body for later analysis.
        logRateLimit({
          provider: adapter.id,
          model,
          upstreamUrl: url,
          status: upstreamStatus,
          headers: upstreamRlHeaders,
          rawBody: errorBody,
        });

        // "too many concurrent requests" with retries left → re-queue
        throwIfTooManyConcurrent(adapter, model, parsedError, canRetry);

        // If configured, don't fallback on 429 — pass it through to the client
        // so Hermes can honor Retry-After and back off without failing the task.
        if (appConfig.doNotFallbackOn429 && upstreamStatus === 429) {
          console.log(
            `[429] DO_NOT_FALLBACK_ON_429: passing ${adapter.id}/${model} 429 through to client`,
          );
          if (!res.headersSent) {
            res.status(429);
            for (const [key, value] of Object.entries(upstreamRlHeaders)) {
              if (value && !HOP_BY_HOP.has(key.toLowerCase())) {
                res.setHeader(key, value as string);
              }
            }
            res.json(parsedError);
          }
          await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
            requestBody: body,
            upstreamUrl: url,
            status: 429,
            stream: true,
            responseBody: parsedError,
            error: `rate-limited:429 | ${errorDetail}`,
          }).catch((err) => {
            console.error('[request-dump] recordUsage failed:', (err as Error)?.message ?? String(err));
          });
          return;
        }

        // Try fallback chain for rate-limit
        const label = upstreamStatus === 413 ? '413 (TPM exceeded)' : '429';
        const rerouted = await tryFallbackChain(
          label,
          adapter,
          model,
          body,
          incomingHeaders,
          res,
          endpointPrefix,
        );
        if (rerouted) return;
        // No fallback — return rate-limit error to client as JSON
        if (!res.headersSent) {
          res.status(upstreamStatus).json(parsedError);
        }
        markIncomingDone?.();
        await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
          requestBody: body,
          upstreamUrl: url,
          status: upstreamStatus,
          stream: true,
          responseBody: parsedError,
          error: `rate-limited:${upstreamStatus} | ${errorDetail}`,
        }).catch((err) => {
          console.error('[request-dump] recordUsage failed:', (err as Error)?.message ?? String(err));
        });
        return;
      }

      // Upstream 5xx — drain body, dump, try fallback chain
      if (upstreamStatus >= 500) {
        let errorBody = '';
        await new Promise<void>((resolve) => {
          upstream!.data.on('data', (chunk: Buffer) => {
            errorBody += chunk.toString('utf8');
          });
          upstream!.data.on('end', resolve);
          upstream!.data.on('error', resolve);
          setTimeout(resolve, 2000);
        });
        (
          upstream.data as NodeJS.ReadableStream & { destroy?: () => void }
        ).destroy?.();
        upstream = null;

        const parsedError = (() => {
          try {
            return JSON.parse(errorBody);
          } catch {
            return errorBody;
          }
        })();
        const errorDetail = formatUpstreamError(upstreamStatus, parsedError);
        recordRequestEnd(reqId, upstreamStatus, errorDetail);
        await logRequestDump({
          provider: adapter.id,
          model,
          upstreamUrl: url,
          status: upstreamStatus,
          stream: true,
          tokensIn: 0,
          tokensOut: 0,
          dollars: 0,
          requestBody: body,
          responseBody: parsedError,
          requestCtx,
          error: `upstream-${upstreamStatus} | ${errorDetail}`,
        }).catch((err) => {
          console.error('[request-dump] logRequestDump failed:', (err as Error)?.message ?? String(err));
        });

        const rerouted = await tryFallbackChain(
          `upstream-${upstreamStatus}`,
          adapter,
          model,
          body,
          incomingHeaders,
          res,
          endpointPrefix,
        );
        if (rerouted) return;
        // No fallback — return upstream error to client as JSON
        if (!res.headersSent) {
          res.status(upstreamStatus).json(parsedError);
        }
        markIncomingDone?.();
        await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
          requestBody: body,
          upstreamUrl: url,
          status: upstreamStatus,
          stream: true,
          responseBody: parsedError,
          error: `upstream-${upstreamStatus} | ${errorDetail}`,
        }).catch((err) => {
          console.error('[request-dump] recordUsage failed:', (err as Error)?.message ?? String(err));
        });
        return;
      }

      res.status(upstreamStatus);
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      for (const [key, value] of Object.entries(upstream.headers)) {
        if (value && !HOP_BY_HOP.has(key.toLowerCase())) {
          res.setHeader(key, value as string | string[]);
        }
      }
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      await new Promise<void>((resolve, reject) => {
        upstream!.data.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (upstreamFailed) {
            rawErrorBody += text;
          } else {
            completionText += extractStreamText(text);
            streamUsage = collectStreamUsage(text, streamUsage);
          }
          res.write(chunk);
          if (
            typeof (res as Response & { flush?: () => void }).flush ===
            'function'
          ) {
            (res as Response & { flush?: () => void }).flush?.();
          }
        });
        upstream!.data.on('end', () => {
          res.end();
          markIncomingDone?.();
          resolve();
        });
        upstream!.data.on('error', reject);
        res.on('close', () => {
          (
            upstream?.data as NodeJS.ReadableStream & {
              destroy?: () => void;
            }
          )?.destroy?.();
        });
      });

      const finalStatus = upstream?.status ?? 502;
      const errorDetail = upstreamFailed
        ? formatUpstreamError(finalStatus, rawErrorBody)
        : undefined;

      await recordUsage(
        adapter,
        model,
        upstreamFailed ? null : streamUsage,
        promptEstimate,
        upstreamFailed ? '' : completionText,
        requestCtx,
        {
          requestBody: body,
          upstreamUrl: url,
          status: finalStatus,
          stream: true,
          responseBody: upstreamFailed ? rawErrorBody : completionText,
          error: errorDetail,
        },
      );

      logResponse({
        provider: adapter.id,
        status: finalStatus,
        preview: completionText,
        stream: true,
        detail: errorDetail,
        endpointPrefix,
        requestedModel: requestedModelName,
        effectiveModel: model,
        fallbackFrom,
      });
      recordModelResponse(
        `${adapter.id}:${model}`,
        finalStatus,
        throughputMetrics(reqStartedAt, completionText, (streamUsage as UsageBreakdown | null)?.usage?.completion_tokens ?? estimateTokensFromText(completionText)),
      );
      recordRequestEnd(reqId, finalStatus, completionText);
    } catch (err) {
      // Re-queue signal must propagate to the queue loop, not fallback.
      if (err instanceof QueueRetry429) throw err;
      // Dump full request + failure info before trying fallback
      const message = describeForwardError(err);
      logProxyError({
        provider: adapter.id,
        endpointPrefix,
        requestedModel: requestedModelName,
        effectiveModel: model,
        message,
      });

      recordModelResponse(`${adapter.id}:${model}`, 502);
      recordRequestEnd(reqId, 502, message);

      await logRequestDump({
        provider: adapter.id,
        model,
        upstreamUrl: url,
        status: 502,
        stream: true,
        tokensIn: 0,
        tokensOut: 0,
        dollars: 0,
        requestBody: body,
        responseBody: { error: message },
        requestCtx,
        error: message,
      }).catch((err) => {
        console.error('[request-dump] logRequestDump failed:', (err as Error)?.message ?? String(err));
      });

      // Try fallback chain before returning 502
      const rerouted = await tryFallbackChain(
        message,
        adapter,
        model,
        body,
        incomingHeaders,
        res,
        endpointPrefix,
      );
      if (!rerouted) {
        await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
          requestBody: body,
          upstreamUrl: url,
          status: 502,
          stream: true,
          responseBody: { error: message },
          error: message,
        }).catch((err) => {
          console.error('[request-dump] recordUsage failed:', (err as Error)?.message ?? String(err));
        });
        if (!res.headersSent) {
          res.status(502).json({ error: { message, type: 'proxy_error' } });
        }
        markIncomingDone?.();
      }
    }
    return;
  }

  // === Non-streaming path ===
  try {
    const upstream = await resilientPost(url, patchedPayload, {
      headers,
      validateStatus: () => true,
    });

    // Rate-limit fallback: 429 or 413 (TPM exceeded) → try chain
    if (upstream.status === 429 || upstream.status === 413) {
      recordModelResponse(`${adapter.id}:${model}`, upstream.status);
      recordRequestEnd(reqId, upstream.status, 'rate-limited');
      await logRequestDump({
        provider: adapter.id,
        model,
        upstreamUrl: url,
        status: upstream.status,
        stream: false,
        tokensIn: 0,
        tokensOut: 0,
        dollars: 0,
        requestBody: body,
        responseBody: upstream.data,
        requestCtx,
        error: `rate-limited:${upstream.status}`,
      }).catch((err) => {
        console.error('[request-dump] logRequestDump failed:', (err as Error)?.message ?? String(err));
      });

      // Diagnostic: capture raw rate-limit headers/body for later analysis.
      logRateLimit({
        provider: adapter.id,
        model,
        upstreamUrl: url,
        status: upstream.status,
        headers: upstream.headers as Record<string, string>,
        rawBody:
          typeof upstream.data === 'string'
            ? upstream.data
            : JSON.stringify(upstream.data),
      });

      // "too many concurrent requests" with retries left → re-queue
      throwIfTooManyConcurrent(adapter, model, upstream.data, canRetry);

      // If configured, don't fallback on 429 — pass it through to the client
      // so Hermes can honor Retry-After and back off without failing the task.
      if (appConfig.doNotFallbackOn429 && upstream.status === 429) {
        console.log(
          `[429] DO_NOT_FALLBACK_ON_429: passing ${adapter.id}/${model} 429 through to client`,
        );
        if (!res.headersSent) {
          res.status(429);
          for (const [key, value] of Object.entries(upstream.headers)) {
            if (value && !HOP_BY_HOP.has(key.toLowerCase())) {
              res.setHeader(key, value as string);
            }
          }
          res.json(upstream.data);
        }
        await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
          requestBody: body,
          upstreamUrl: url,
          status: 429,
          stream: false,
          responseBody: upstream.data,
          error: 'rate-limited:429',
        }).catch((err) => {
          console.error('[request-dump] recordUsage failed:', (err as Error)?.message ?? String(err));
        });
        return;
      }

      const label = upstream.status === 413 ? '413 (TPM exceeded)' : '429';
      const rerouted = await tryFallbackChain(
        label,
        adapter,
        model,
        body,
        incomingHeaders,
        res,
        endpointPrefix,
      );
      if (rerouted) return;
    }

    // Upstream 5xx or 402 (insufficient balance) — try fallback chain before passing through to client
    if (upstream.status >= 500 || upstream.status === 402) {
      recordModelResponse(`${adapter.id}:${model}`, upstream.status);
      recordRequestEnd(reqId, upstream.status, `upstream-${upstream.status}`);
      await logRequestDump({
        provider: adapter.id,
        model,
        upstreamUrl: url,
        status: upstream.status,
        stream: false,
        tokensIn: 0,
        tokensOut: 0,
        dollars: 0,
        requestBody: body,
        responseBody: upstream.data,
        requestCtx,
        error: `upstream-${upstream.status}`,
      }).catch((err) => {
        console.error('[request-dump] logRequestDump failed:', (err as Error)?.message ?? String(err));
      });

      const rerouted = await tryFallbackChain(
        `upstream-${upstream.status}`,
        adapter,
        model,
        body,
        incomingHeaders,
        res,
        endpointPrefix,
      );
      if (rerouted) return;
    }

    const upstreamFailed = upstream.status >= 400;

    // Track live rate-limit headers from upstream
    trackUpstreamHeaders(
      adapter.id,
      upstream.headers as Record<string, string>,
    );

    // OpenRouter 402: insufficient credits due to max_tokens too high.
    // The error body contains "you can only afford N" — retry with cap.
    if (
      upstream.status === 402 &&
      typeof upstream.data === 'object' &&
      upstream.data
    ) {
      const errData = upstream.data as Record<string, unknown>;
      const rawMsg = String(errData.message ?? errData.error ?? '');
      const affordMatch = rawMsg.match(/can only afford (\d+)/i);
      if (
        affordMatch &&
        typeof patchedPayload.max_tokens === 'number' &&
        patchedPayload.max_tokens > 0
      ) {
        const affordable = Number(affordMatch[1]);
        if (affordable > 0 && affordable < patchedPayload.max_tokens) {
          console.log(
            `[402_CAP] ${adapter.id} | ${model} | max_tokens ${patchedPayload.max_tokens} → ${affordable}`,
          );
          const cappedPayload = { ...patchedPayload, max_tokens: affordable };
          const retryResp = await resilientPost(url, cappedPayload, {
            headers,
            validateStatus: () => true,
          });
          const retryFailed = retryResp.status >= 400;
          trackUpstreamHeaders(
            adapter.id,
            retryResp.headers as Record<string, string>,
          );
          const retryErrorDetail = retryFailed
            ? formatUpstreamError(retryResp.status, retryResp.data)
            : undefined;
          const retryText =
            !retryFailed &&
            retryResp.data &&
            typeof retryResp.data === 'object'
              ? String(
                  (
                    retryResp.data as {
                      choices?: Array<{
                        message?: { content?: string };
                      }>;
                    }
                  ).choices?.[0]?.message?.content ?? '',
                )
              : '';
          logResponse({
            provider: adapter.id,
            status: retryResp.status,
            preview: retryText,
            stream: false,
            detail: retryErrorDetail,
            endpointPrefix,
            requestedModel: requestedModelName,
            effectiveModel: model,
            fallbackFrom,
          });
          recordModelResponse(
            `${adapter.id}:${model}`,
            retryResp.status,
            !retryFailed
              ? throughputMetrics(reqStartedAt, retryText, parseUsage(retryResp.data)?.usage.completion_tokens)
              : undefined,
          );
          recordRequestEnd(reqId, retryResp.status, retryText);
          const usage = parseUsage(retryResp.data);
          await recordUsage(
            adapter,
            model,
            usage,
            promptEstimate,
            retryText,
            requestCtx,
            {
              requestBody: body,
              upstreamUrl: url,
              status: retryResp.status,
              stream: false,
              responseBody: retryResp.data,
              error: retryErrorDetail,
            },
          ).catch((dumpErr) => {
            logProxyError({
              provider: adapter.id,
              endpointPrefix,
              requestedModel: requestedModelName,
              effectiveModel: model,
              message: describeForwardError(dumpErr),
            });
          });
          res.status(retryResp.status).json(convertMiniMaxAgenticToolCall(retryResp.data));
          return;
        }
      }
      // Not a fixable 402 — fall through to normal error handling
    }

    let errorDetail = upstreamFailed
      ? formatUpstreamError(upstream.status, upstream.data)
      : undefined;
    let completionText =
      !upstreamFailed &&
      typeof upstream.data === 'object' &&
      upstream.data &&
      'choices' in upstream.data
        ? String(
            (
              upstream.data as {
                choices?: Array<{ message?: { content?: string } }>;
              }
            ).choices?.[0]?.message?.content ?? '',
          )
        : '';

    // Garbage detected in non-streaming output — treat as upstream error, try fallback
    if (!upstreamFailed && completionText && isGarbage(completionText)) {
      recordModelResponse(`${adapter.id}:${model}`, 0);
      recordRequestEnd(reqId, 0, 'garbage-detected');
      const metrics = analyzeText(completionText);
      logProxyError({
        provider: adapter.id,
        endpointPrefix,
        requestedModel: requestedModelName,
        effectiveModel: model,
        message: `garbage detected (cjks=${metrics.maxCJK}, artifacts=${metrics.artifactWords}, ratio=${metrics.garbageRatio.toFixed(3)}), trying fallback chain`,
      });
      await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
        requestBody: body,
        upstreamUrl: url,
        status: 200,
        stream: false,
        responseBody: completionText,
        error: 'garbage-detected',
      }).catch((err) => {
        console.error('[request-dump] recordUsage failed:', (err as Error)?.message ?? String(err));
      });
      const rerouted = await tryFallbackChain(
        'garbage-detected',
        adapter,
        model,
        body,
        incomingHeaders,
        res,
        endpointPrefix,
      );
      if (!rerouted) {
        sendOverwhelmedResponse(res, model);
      }
      return;
    }

    logResponse({
      provider: adapter.id,
      status: upstream.status,
      preview: completionText,
      stream: false,
      detail: errorDetail,
      endpointPrefix,
      requestedModel: requestedModelName,
      effectiveModel: model,
      fallbackFrom,
    });

    recordModelResponse(
      `${adapter.id}:${model}`,
      upstream.status,
      throughputMetrics(reqStartedAt, completionText, parseUsage(upstream.data)?.usage.completion_tokens ?? estimateTokensFromText(completionText)),
    );
    recordRequestEnd(reqId, upstream.status, completionText);

    const usage = parseUsage(upstream.data);

    await recordUsage(
      adapter,
      model,
      usage,
      promptEstimate,
      completionText,
      requestCtx,
      {
        requestBody: body,
        upstreamUrl: url,
        status: upstream.status,
        stream: false,
        responseBody: upstream.data,
        error: errorDetail,
      },
    ).catch((dumpErr) => {
      logProxyError({
        provider: adapter.id,
        endpointPrefix,
        requestedModel: requestedModelName,
        effectiveModel: model,
        message: describeForwardError(dumpErr),
      });
    });

    res.status(upstream.status).json(convertMiniMaxAgenticToolCall(upstream.data));
    markIncomingDone?.();
  } catch (err) {
    // Re-queue signal must propagate to the queue loop, not fallback.
    if (err instanceof QueueRetry429) throw err;
    // Dump full request + failure info before trying fallback
    const message = describeForwardError(err);
    logProxyError({
      provider: adapter.id,
      endpointPrefix,
      requestedModel: requestedModelName,
      effectiveModel: model,
      message,
    });

    recordModelResponse(`${adapter.id}:${model}`, 502);
    recordRequestEnd(reqId, 502, message);

    await logRequestDump({
      provider: adapter.id,
      model,
      upstreamUrl: url,
      status: 502,
      stream: false,
      tokensIn: 0,
      tokensOut: 0,
      dollars: 0,
      requestBody: body,
      responseBody: { error: message },
      requestCtx,
      error: message,
    }).catch((err) => {
      console.error('[request-dump] logRequestDump failed:', (err as Error)?.message ?? String(err));
    });

    // Try fallback chain before returning 502
    const rerouted = await tryFallbackChain(
      message,
      adapter,
      model,
      body,
      incomingHeaders,
      res,
      endpointPrefix,
    );
    if (!rerouted) {
      await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
        requestBody: body,
        upstreamUrl: url,
        status: 502,
        stream: false,
        responseBody: { error: message },
        error: message,
      }).catch((err) => {
        console.error('[request-dump] recordUsage failed:', (err as Error)?.message ?? String(err));
      });
      if (!res.headersSent) {
        res.status(502).json({ error: { message, type: 'proxy_error' } });
      }
    }
  }
}

/**
 * Gonka streaming with garbage detection.
 *
 * Buffers the complete stream, checks for garbage. If clean — flushes to client.
 * If garbage (or network error) — tries fallback chain. No retry loop —
 * garbage is treated exactly like a backend error.
 */
async function forwardStreamWithGarbageProtection(
  adapter: ProviderAdapter,
  model: string,
  payload: ChatCompletionRequest,
  headers: Record<string, string>,
  url: string,
  body: ChatCompletionRequest,
  requestCtx: CompletionRequestContext,
  promptEstimate: number,
  res: Response,
  incomingHeaders: IncomingHttpHeaders,
  endpointPrefix: string,
  reqStartedAt: number,
  fallbackFrom?: string,
  /** Whether a QueueRetry429 re-queue is still available (RETRY_LOOP_COUNTER). */
  canRetry = true,
  reqId = '',
  markIncomingDone?: () => void,
): Promise<void> {
  const requestedModelName = String(body.model ?? '');
  let completionText = '';
  let streamUsage: UsageBreakdown | null = null;
  let chunks: Buffer[] = [];
  let upstreamStatus = 502;
  let upstreamHeaders: Record<string, string> = {};
  let errorDetail: string | undefined;

  try {
    const result = await bufferedStreamRequest(url, payload, headers);
    completionText = result.completionText;
    streamUsage = result.streamUsage;
    chunks = result.chunks;
    upstreamStatus = result.status;
    upstreamHeaders = result.upstreamHeaders;

    if (upstreamStatus >= 400) {
      errorDetail = formatUpstreamError(upstreamStatus, result.rawErrorBody);
    }
  } catch (err) {
    const message = describeForwardError(err);
    recordModelResponse(`${adapter.id}:${model}`, 502);
    recordRequestEnd(reqId, 502, message);
    logProxyError({
      provider: adapter.id,
      endpointPrefix,
      requestedModel: requestedModelName,
      effectiveModel: model,
      message,
    });
    // Treat network error same as garbage — try fallback
    const rerouted = await tryFallbackChain(
      message,
      adapter,
      model,
      body,
      incomingHeaders,
      res,
      endpointPrefix,
    );
    if (!rerouted) {
      await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
        requestBody: body,
        upstreamUrl: url,
        status: 502,
        stream: true,
        responseBody: { error: message },
        error: message,
      }).catch((err) => {
        console.error('[request-dump] recordUsage failed:', (err as Error)?.message ?? String(err));
      });
      if (!res.headersSent) {
        res.status(502).json({ error: { message, type: 'proxy_error' } });
      }
    }
    return;
  }

  // Upstream error — try fallback (or pass 429 through when configured)
  if (upstreamStatus >= 400) {
    recordModelResponse(`${adapter.id}:${model}`, upstreamStatus);
    // "too many concurrent requests" with retries left → re-queue
    if (upstreamStatus === 429) {
      throwIfTooManyConcurrent(adapter, model, errorDetail ?? '', canRetry);
    }
    if (upstreamStatus === 429 && appConfig.doNotFallbackOn429) {
      console.log(
        `[429] DO_NOT_FALLBACK_ON_429: passing ${adapter.id}/${model} 429 through to client`,
      );
      logRateLimit({
        provider: adapter.id,
        model,
        upstreamUrl: url,
        status: 429,
        headers: upstreamHeaders,
        rawBody: errorDetail ?? '',
      });
      await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
        requestBody: body,
        upstreamUrl: url,
        status: 429,
        stream: true,
        responseBody: errorDetail ?? '',
        error: 'rate-limited:429',
      }).catch((err) => {
        console.error('[request-dump] recordUsage failed:', (err as Error)?.message ?? String(err));
      });
      flushBufferedChunks(res, chunks, 429, upstreamHeaders, markIncomingDone);
      return;
    }

    const rerouted = await tryFallbackChain(
      `upstream-${upstreamStatus}`,
      adapter,
      model,
      body,
      incomingHeaders,
      res,
      endpointPrefix,
    );
    if (!rerouted) {
      await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
        requestBody: body,
        upstreamUrl: url,
        status: upstreamStatus,
        stream: true,
        responseBody: errorDetail ?? '',
        error: errorDetail,
      }).catch((err) => {
        console.error('[request-dump] recordUsage failed:', (err as Error)?.message ?? String(err));
      });
      flushBufferedChunks(res, chunks, upstreamStatus, upstreamHeaders, markIncomingDone);
    }
    return;
  }

  // Clean output — flush to client (converting any MiniMax tool-call XML first)
  if (!isGarbage(completionText)) {
    const outChunks = rewriteStreamForMiniMax(chunks, completionText, model);
    flushBufferedChunks(res, outChunks, upstreamStatus, upstreamHeaders, markIncomingDone);

    await recordUsage(
      adapter,
      model,
      streamUsage,
      promptEstimate,
      completionText,
      requestCtx,
      {
        requestBody: body,
        upstreamUrl: url,
        status: upstreamStatus,
        stream: true,
        responseBody: completionText,
      },
    );

    logResponse({
      provider: adapter.id,
      status: upstreamStatus,
      preview: completionText,
      stream: true,
      endpointPrefix,
      requestedModel: requestedModelName,
      effectiveModel: model,
      fallbackFrom,
    });
    recordModelResponse(
      `${adapter.id}:${model}`,
      upstreamStatus,
      throughputMetrics(reqStartedAt, completionText, streamUsage?.usage.completion_tokens ?? estimateTokensFromText(completionText)),
    );
    recordRequestEnd(reqId, upstreamStatus, completionText);
    return;
  }

  // Garbage detected — log, try fallback chain (no retry to same model)
  recordModelResponse(`${adapter.id}:${model}`, 0);
  recordRequestEnd(reqId, 0, 'garbage-detected');
  const metrics = analyzeText(completionText);
  const garbageLog = `garbage detected in stream (cjks=${metrics.maxCJK}, digits=${metrics.maxDigits}, artifacts=${metrics.artifactWords}, ratio=${metrics.garbageRatio.toFixed(3)}), trying fallback chain`;
  logProxyError({
    provider: adapter.id,
    endpointPrefix,
    requestedModel: requestedModelName,
    effectiveModel: model,
    message: garbageLog,
  });

  await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
    requestBody: body,
    upstreamUrl: url,
    status: 200,
    stream: true,
    responseBody: completionText,
    error: 'garbage-detected',
  }).catch((err) => {
    console.error('[request-dump] recordUsage failed:', (err as Error)?.message ?? String(err));
  });

  const rerouted = await tryFallbackChain(
    'garbage-detected',
    adapter,
    model,
    body,
    incomingHeaders,
    res,
    endpointPrefix,
  );
  if (!rerouted) {
    sendOverwhelmedResponse(res, model);
  }
}