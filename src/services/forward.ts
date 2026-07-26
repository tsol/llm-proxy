import axios, { type AxiosResponse } from 'axios';
import type { IncomingHttpHeaders } from 'http';
import type { Response } from 'express';
import type {
  ChatCompletionRequest,
  CompletionRequestContext,
  ProviderAdapter,
  ProviderId,
  TokenUsage,
} from '../types';
import { appConfig } from '../config';
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

const GARBAGE_RETRY_DELAY_MS = 15_000;
const MAX_GARBAGE_RETRIES = 2;

const OVERWHELMED_MESSAGE = "I am a bit overwhelmed. Let me take a deep breath and continue.";

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
    breakdown?.usage.completion_tokens ?? estimateTokensFromText(completionText);

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
    const choices = (parsed as { choices?: Array<{ delta?: { content?: string } }> })
      .choices;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a graceful "overwhelmed" non-streaming JSON response.
 * Used as a fallback when all garbage-retry attempts have been exhausted.
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

  await new Promise<void>((resolve, reject) => {
    upstream.data.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const text = chunk.toString('utf8');
      if (upstreamFailed) {
        rawErrorBody += text;
      } else {
        completionText += extractStreamText(text);
        streamUsage = collectStreamUsage(text, streamUsage);
      }
    });
    upstream.data.on('end', () => {
      // Close upstream cleanly after buffering — we re-stream validated chunks later
      (upstream.data as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      resolve();
    });
    upstream.data.on('error', (err) => {
      (upstream.data as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      reject(err);
    });
  });

  return { completionText, streamUsage, chunks, status: upstream.status, upstreamHeaders, rawErrorBody };
}

/**
 * Forward the pre-collected chunks to the client as-is (SSE streaming).
 */
function flushBufferedChunks(
  res: Response,
  chunks: Buffer[],
  upstreamStatus: number,
  upstreamHeaders: Record<string, string>,
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
}

interface FallbackRoute {
  adapter: ProviderAdapter;
  model: string;
}

/**
 * Resolve the configured rate-limit fallback model alias into a provider + upstream model.
 * Returns null if RATE_LIMIT_FALLBACK_MODEL is not set or can't be resolved.
 */
/**
 * Try the configured fallback chain (MODEL_FALLBACK_CHAIN in .env).
 * Each entry is "provider/model" — e.g. "gonka/Kimi-K2.6".
 * Returns true if a fallback was tried (possibly succeeded, possibly failed).
 */
async function tryFallbackChain(
  label: string,
  originalAdapter: ProviderAdapter,
  originalModel: string,
  body: ChatCompletionRequest,
  incomingHeaders: IncomingHttpHeaders,
  res: Response,
): Promise<boolean> {
  // First, check if the current model has an alias-specific TRY chain
  let chain: string[] | undefined;
  const requestedModel = body.model as string | undefined;
  if (requestedModel && appConfig.modelAliases) {
    // Try exact match first, then check if we were called for a specific alias
    chain = appConfig.modelAliases.get(requestedModel);
  }
  // Fall back to global MODEL_FALLBACK_CHAIN
  if (!chain || !chain.length) {
    chain = appConfig.modelFallbackChain;
  }
  if (!chain.length) return false;

  for (let i = 0; i < chain.length; i++) {
    const alias = chain[i];
    const route = await resolveModelRoute(alias);
    if (!route) {
      console.warn(`[fallback] could not resolve "${alias}" in chain — skipping`);
      continue;
    }

    // Don't fallback to self
    if (route.provider === originalAdapter.id && route.upstreamModel === originalModel) {
      continue;
    }

    console.log(
      `[${new Date().toISOString().slice(11, 19)}] FALLBACK ${originalAdapter.id} | ${truncateMiddle(originalModel, 40)} | ${label} → chain[${i}]: ${route.provider}/${route.upstreamModel}`,
    );
    logProxyError({
      provider: originalAdapter.id,
      model: originalModel,
      message: `${label}, falling back to ${route.provider}/${route.upstreamModel} (chain[${i}])`,
    });

    try {
      await forwardChatCompletion(
        getProvider(route.provider),
        route.upstreamModel,
        body,
        incomingHeaders,
        res,
      );
      return true; // succeeded
    } catch {
      // This fallback also failed — try next in chain
      logProxyError({
        provider: route.provider,
        model: route.upstreamModel,
        message: `fallback chain[${i}] also failed, trying next`,
      });
    }
  }

  return false; // all fallbacks exhausted
}

type ChatMessage = { role: string; content: string | unknown };

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
      const prev = typeof cloned[sysIdx].content === 'string' ? cloned[sysIdx].content : '';
      cloned[sysIdx] = { ...cloned[sysIdx], content: prefix + '\n\n' + (prev as string) };
    } else {
      // Insert system message at the beginning
      cloned.unshift({ role: 'system', content: prefix });
    }
  }

  // Append to the last user message
  if (suffix) {
    for (let i = cloned.length - 1; i >= 0; i--) {
      if (cloned[i].role === 'user') {
        const prev = typeof cloned[i].content === 'string' ? cloned[i].content : '';
        cloned[i] = { ...cloned[i], content: (prev as string) + '\n\n' + suffix };
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

export async function forwardChatCompletion(
  adapter: ProviderAdapter,
  activeModel: string,
  body: ChatCompletionRequest,
  incomingHeaders: IncomingHttpHeaders,
  res: Response,
): Promise<void> {
  const model = activeModel.trim() || adapter.resolveModel(body.model);
  const payload = withStreamUsage({ ...body, model });
  const requestCtx = captureRequestContext(body.messages);
  const promptEstimate = estimateTokensFromMessages(body.messages);
  const url = adapter.chatCompletionsUrl();
  const headers = forwardHeaders(incomingHeaders, adapter.config.apiKey, adapter.config.extraHeaders);
  const streaming = Boolean(body.stream);

  // Apply system prompt overrides
  const messages = applyPromptOverrides(body.messages);
  let patchedPayload: ChatCompletionRequest = messages !== body.messages
    ? { ...payload, messages }
    : payload;

  // Strip parameters unsupported by specific providers
  patchedPayload = sanitizeProviderParams(adapter.id, patchedPayload, adapter);

  logOutgoing({
    provider: adapter.id,
    url,
    model,
    stream: streaming,
  });

  // === Streaming path ===
  if (body.stream) {
    // Gonka garbage-protection: buffer, detect, retry
    if (adapter.id === 'gonka') {
      await forwardStreamWithGarbageProtection(
        adapter, model, patchedPayload, headers, url, body, requestCtx, promptEstimate, res,
      );
      return;
    }

    // Non-gonka streaming: forward directly
    let completionText = '';
    let rawErrorBody = '';
    let streamUsage: UsageBreakdown | null = null;
    let upstream: AxiosResponse<NodeJS.ReadableStream> | null = null;

    try {
      upstream = await resilientPost<NodeJS.ReadableStream>(url, patchedPayload, {
        headers,
        responseType: 'stream',
        validateStatus: () => true,
      });
      const upstreamStatus = upstream.status;
      const upstreamFailed = upstreamStatus >= 400;

      // Track live rate-limit headers from upstream
      trackUpstreamHeaders(adapter.id, upstream.headers as Record<string, string>);

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
        (upstream.data as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        upstream = null;

        // Dump full request + upstream error response before falling back
        const parsedError = (() => {
          try { return JSON.parse(errorBody); } catch { return errorBody; }
        })();
        const errorDetail = formatUpstreamError(upstreamStatus, parsedError);
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
        }).catch(() => {});

        // Try fallback chain for rate-limit
        const label = upstreamStatus === 413 ? '413 (TPM exceeded)' : '429';
        const rerouted = await tryFallbackChain(
          label, adapter, model, body, incomingHeaders, res,
        );
        if (rerouted) return;
        // No fallback — return rate-limit error to client as JSON
        if (!res.headersSent) {
          res.status(upstreamStatus).json(parsedError);
        }
        await recordUsage(
          adapter, model, null, promptEstimate, '', requestCtx,
          {
            requestBody: body, upstreamUrl: url, status: upstreamStatus,
            stream: true,
            responseBody: parsedError,
            error: `rate-limited:${upstreamStatus} | ${errorDetail}`,
          },
        ).catch(() => {});
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
          if (typeof (res as Response & { flush?: () => void }).flush === 'function') {
            (res as Response & { flush?: () => void }).flush?.();
          }
        });
        upstream!.data.on('end', () => {
          res.end();
          resolve();
        });
        upstream!.data.on('error', reject);
        res.on('close', () => {
          (upstream?.data as NodeJS.ReadableStream & { destroy?: () => void })?.destroy?.();
        });
      });

      const finalStatus = upstream?.status ?? 502;
      const errorDetail = upstreamFailed
        ? formatUpstreamError(finalStatus, rawErrorBody)
        : undefined;

      await recordUsage(
        adapter, model, upstreamFailed ? null : streamUsage,
        promptEstimate, upstreamFailed ? '' : completionText,
        requestCtx,
        {
          requestBody: body, upstreamUrl: url, status: finalStatus,
          stream: true,
          responseBody: upstreamFailed ? rawErrorBody : completionText,
          error: errorDetail,
        },
      );

      logResponse({
        provider: adapter.id, model, status: finalStatus,
        preview: completionText, stream: true, detail: errorDetail,
      });
    } catch (err) {
      // Dump full request + failure info before trying fallback
      const message = describeForwardError(err);
      logProxyError({ provider: adapter.id, model, message });

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
      }).catch(() => {});

      // Try fallback chain before returning 502
      const rerouted = await tryFallbackChain(
        message, adapter, model, body, incomingHeaders, res,
      );
      if (!rerouted) {
        await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
          requestBody: body, upstreamUrl: url, status: 502, stream: true,
          responseBody: { error: message }, error: message,
        }).catch(() => {});
        if (!res.headersSent) {
          res.status(502).json({ error: { message, type: 'proxy_error' } });
        }
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
      }).catch(() => {});

      const label = upstream.status === 413 ? '413 (TPM exceeded)' : '429';
      const rerouted = await tryFallbackChain(
        label, adapter, model, body, incomingHeaders, res,
      );
      if (rerouted) return;
    }

    const upstreamFailed = upstream.status >= 400;

    // Track live rate-limit headers from upstream
    trackUpstreamHeaders(adapter.id, upstream.headers as Record<string, string>);

    // OpenRouter 402: insufficient credits due to max_tokens too high.
    // The error body contains "you can only afford N" — retry with cap.
    if (upstream.status === 402 && typeof upstream.data === 'object' && upstream.data) {
      const errData = upstream.data as Record<string, unknown>;
      const rawMsg = String(errData.message ?? errData.error ?? '');
      const affordMatch = rawMsg.match(/can only afford (\d+)/i);
      if (affordMatch && typeof patchedPayload.max_tokens === 'number' && patchedPayload.max_tokens > 0) {
        const affordable = Number(affordMatch[1]);
        if (affordable > 0 && affordable < patchedPayload.max_tokens) {
          console.log(
            `[${new Date().toISOString().slice(11, 19)}] 402_CAP ${adapter.id} | ${truncateMiddle(model, 40)} | max_tokens ${patchedPayload.max_tokens} → ${affordable}`,
          );
          const cappedPayload = { ...patchedPayload, max_tokens: affordable };
          const retryResp = await resilientPost(url, cappedPayload, {
            headers, validateStatus: () => true,
          });
          const retryFailed = retryResp.status >= 400;
          trackUpstreamHeaders(adapter.id, retryResp.headers as Record<string, string>);
          const retryErrorDetail = retryFailed ? formatUpstreamError(retryResp.status, retryResp.data) : undefined;
          const retryText = !retryFailed && retryResp.data && typeof retryResp.data === 'object'
            ? String((retryResp.data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? '')
            : '';
          logResponse({
            provider: adapter.id, model,
            status: retryResp.status,
            preview: retryText, stream: false,
            detail: retryErrorDetail,
          });
          const usage = parseUsage(retryResp.data);
          await recordUsage(adapter, model, usage, promptEstimate, retryText, requestCtx, {
            requestBody: body, upstreamUrl: url, status: retryResp.status, stream: false,
            responseBody: retryResp.data, error: retryErrorDetail,
          }).catch((dumpErr) => {
            logProxyError({ provider: adapter.id, model, message: describeForwardError(dumpErr) });
          });
          res.status(retryResp.status).json(retryResp.data);
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
            (upstream.data as { choices?: Array<{ message?: { content?: string } }> })
              .choices?.[0]?.message?.content ?? '',
          )
        : '';

    // Gonka non-streaming garbage protection
    if (adapter.id === 'gonka' && !upstreamFailed && completionText) {
      let attempt = 0;
      while (isGarbage(completionText) && attempt < MAX_GARBAGE_RETRIES) {
        attempt++;
        const metrics = analyzeText(completionText);
        logProxyError({
          provider: adapter.id, model,
          message: `garbage detected (cjks=${metrics.maxCJK}, artifacts=${metrics.artifactWords}, ratio=${metrics.garbageRatio.toFixed(3)}), retry ${attempt}/${MAX_GARBAGE_RETRIES}`,
        });
        await sleep(GARBAGE_RETRY_DELAY_MS);

        // Re-do the non-streaming request
        try {
          const retryResp = await resilientPost(url, patchedPayload, {
            headers, validateStatus: () => true,
          });
          const retryFailed = retryResp.status >= 400;
          errorDetail = retryFailed
            ? formatUpstreamError(retryResp.status, retryResp.data)
            : undefined;
          completionText =
            !retryFailed &&
            typeof retryResp.data === 'object' &&
            retryResp.data &&
            'choices' in retryResp.data
              ? String(
                  (retryResp.data as { choices?: Array<{ message?: { content?: string } }> })
                    .choices?.[0]?.message?.content ?? '',
                )
              : '';
        } catch (retryErr) {
          logProxyError({
            provider: adapter.id, model,
            message: `garbage retry failed: ${describeForwardError(retryErr)}`,
          });
          // Fall through to overwhelmed response
          completionText = '';
          break;
        }
      }

      // If still garbage after all retries, send overwhelmed
      if (completionText && isGarbage(completionText)) {
        logProxyError({
          provider: adapter.id, model,
          message: `garbage persist after ${MAX_GARBAGE_RETRIES} retries, returning overwhelmed`,
        });
        sendOverwhelmedResponse(res, model);
        return;
      }
    }

    logResponse({
      provider: adapter.id, model,
      status: upstream.status,
      preview: completionText, stream: false,
      detail: errorDetail,
    });

    const usage = parseUsage(upstream.data);

    await recordUsage(adapter, model, usage, promptEstimate, completionText, requestCtx, {
      requestBody: body, upstreamUrl: url, status: upstream.status, stream: false,
      responseBody: upstream.data, error: errorDetail,
    }).catch((dumpErr) => {
      logProxyError({ provider: adapter.id, model, message: describeForwardError(dumpErr) });
    });

    res.status(upstream.status).json(upstream.data);
  } catch (err) {
    // Dump full request + failure info before trying fallback
    const message = describeForwardError(err);
    logProxyError({ provider: adapter.id, model, message });

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
    }).catch(() => {});

    // Try fallback chain before returning 502
    const rerouted = await tryFallbackChain(
      message, adapter, model, body, incomingHeaders, res,
    );
    if (!rerouted) {
      await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
        requestBody: body, upstreamUrl: url, status: 502, stream: false,
        responseBody: { error: message }, error: message,
      }).catch(() => {});
      if (!res.headersSent) {
        res.status(502).json({ error: { message, type: 'proxy_error' } });
      }
    }
  }
}

/**
 * Gonka-specific streaming with garbage detection and retry.
 * Buffers the complete stream, checks for garbage, retries if needed,
 * and then flushes the clean chunks to the client.
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
): Promise<void> {
  let completionText = '';
  let streamUsage: UsageBreakdown | null = null;
  let chunks: Buffer[] = [];
  let upstreamStatus = 502;
  let upstreamHeaders: Record<string, string> = {};
  let errorDetail: string | undefined;
  let attempt = 0;

  while (attempt <= MAX_GARBAGE_RETRIES) {

    attempt++;
    try {
      const result = await bufferedStreamRequest(url, payload, headers);
      completionText = result.completionText;
      streamUsage = result.streamUsage;
      chunks = result.chunks;
      upstreamStatus = result.status;
      upstreamHeaders = result.upstreamHeaders;

      if (upstreamStatus >= 400) {
        errorDetail = formatUpstreamError(upstreamStatus, result.rawErrorBody);
        break; // Don't retry upstream errors
      }

      if (!isGarbage(completionText)) {
        errorDetail = undefined;
        break; // Clean output — send it
      }

      // Garbage detected
      const metrics = analyzeText(completionText);
      const garbageLog = `garbage detected in stream (cjks=${metrics.maxCJK}, artifacts=${metrics.artifactWords}, ratio=${metrics.garbageRatio.toFixed(3)}), attempt ${attempt}/${MAX_GARBAGE_RETRIES + 1}`;
      console.log(`[${new Date().toISOString().slice(11,19)}] GARBAGE gonka | ${truncateMiddle(model, 40)} | ${garbageLog}`);
      logProxyError({ provider: adapter.id, model, message: garbageLog });

      if (attempt <= MAX_GARBAGE_RETRIES) {
        await sleep(GARBAGE_RETRY_DELAY_MS);
      }
    } catch (err) {
      const message = describeForwardError(err);
      logProxyError({ provider: adapter.id, model, message });
      if (attempt <= MAX_GARBAGE_RETRIES) {
        await sleep(GARBAGE_RETRY_DELAY_MS);
        continue;
      }
      // Exhausted retries after network error
      await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
        requestBody: body, upstreamUrl: url, status: 502, stream: true,
        responseBody: { error: message }, error: message,
      }).catch(() => {});
      if (!res.headersSent) {
        res.status(502).json({ error: { message, type: 'proxy_error' } });
      }
      return;
    }
  }

  // After retry loop: check if we got garbage that persisted
  if (completionText && isGarbage(completionText) && upstreamStatus < 400) {
    logProxyError({
      provider: adapter.id, model,
      message: `garbage persist in stream after ${MAX_GARBAGE_RETRIES + 1} attempts, returning overwhelmed`,
    });
    await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
      requestBody: body, upstreamUrl: url, status: 200, stream: true,
      responseBody: OVERWHELMED_MESSAGE, error: 'garbage-persist:overwhelmed',
    }).catch(() => {});
    sendOverwhelmedResponse(res, model);
    return;
  }

  // Flush the buffered clean chunks to the client
  flushBufferedChunks(res, chunks, upstreamStatus, upstreamHeaders);

  await recordUsage(
    adapter, model,
    upstreamStatus >= 400 ? null : streamUsage,
    promptEstimate,
    errorDetail ? '' : completionText,
    requestCtx,
    {
      requestBody: body, upstreamUrl: url, status: upstreamStatus, stream: true,
      responseBody: errorDetail ? errorDetail : completionText,
      error: errorDetail,
    },
  );

  logResponse({
    provider: adapter.id, model, status: upstreamStatus,
    preview: completionText, stream: true, detail: errorDetail,
  });
}