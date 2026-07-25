import axios, { type AxiosResponse } from 'axios';
import type { IncomingHttpHeaders } from 'http';
import type { Response } from 'express';
import type {
  ChatCompletionRequest,
  CompletionRequestContext,
  ProviderAdapter,
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
import { logRequestDump } from '../services/request-dump-logger';
import {
  formatUpstreamError,
  logOutgoing,
  logProxyError,
  logResponse,
  truncateMiddle,
} from '../services/request-logger';
import { isGarbage, analyzeText } from './garbage-detector';

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
  const headers = forwardHeaders(incomingHeaders, adapter.config.apiKey);
  const streaming = Boolean(body.stream);

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
        adapter, model, payload, headers, url, body, requestCtx, promptEstimate, res,
      );
      return;
    }

    // Non-gonka streaming: forward directly
    let completionText = '';
    let rawErrorBody = '';
    let streamUsage: UsageBreakdown | null = null;
    let upstream: AxiosResponse<NodeJS.ReadableStream> | null = null;

    try {
      upstream = await resilientPost<NodeJS.ReadableStream>(url, payload, {
        headers,
        responseType: 'stream',
        validateStatus: () => true,
      });
      const upstreamFailed = upstream.status >= 400;

      res.status(upstream.status);
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

      const upstreamStatus = upstream?.status ?? 502;
      const errorDetail = upstreamFailed
        ? formatUpstreamError(upstreamStatus, rawErrorBody)
        : undefined;

      await recordUsage(
        adapter, model, upstreamFailed ? null : streamUsage,
        promptEstimate, upstreamFailed ? '' : completionText,
        requestCtx,
        {
          requestBody: body, upstreamUrl: url, status: upstreamStatus,
          stream: true,
          responseBody: upstreamFailed ? rawErrorBody : completionText,
          error: errorDetail,
        },
      );

      logResponse({
        provider: adapter.id, model, status: upstreamStatus,
        preview: completionText, stream: true, detail: errorDetail,
      });
    } catch (err) {
      const message = describeForwardError(err);
      logProxyError({ provider: adapter.id, model, message });
      await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
        requestBody: body, upstreamUrl: url, status: 502, stream: true,
        responseBody: { error: message }, error: message,
      }).catch(() => {});
      if (!res.headersSent) {
        res.status(502).json({ error: { message, type: 'proxy_error' } });
      }
    }
    return;
  }

  // === Non-streaming path ===
  try {
    const upstream = await resilientPost(url, payload, {
      headers,
      validateStatus: () => true,
    });

    const upstreamFailed = upstream.status >= 400;
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
          const retryResp = await resilientPost(url, payload, {
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
    const message = describeForwardError(err);
    logProxyError({ provider: adapter.id, model, message });
    await recordUsage(adapter, model, null, promptEstimate, '', requestCtx, {
      requestBody: body, upstreamUrl: url, status: 502, stream: false,
      responseBody: { error: message }, error: message,
    }).catch(() => {});
    if (!res.headersSent) {
      res.status(502).json({ error: { message, type: 'proxy_error' } });
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