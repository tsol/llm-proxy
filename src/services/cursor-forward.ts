import { Agent, CursorAgentError } from '@cursor/sdk';
import type { SettingSource } from '@cursor/sdk';
import type { Response } from 'express';
import type { ChatCompletionRequest, CompletionRequestContext, TokenUsage } from '../types';
import { appConfig } from '../config';
import { parseCursorModelSelection } from '../providers/cursor';
import type { CursorProvider } from '../providers/cursor';
import {
  captureRequestContext,
  computeCost,
  estimateTokensFromMessages,
  estimateTokensFromText,
  logCost,
} from './cost-logger';
import { logRequestDump } from './request-dump-logger';
import { logOutgoing, logProxyError, logResponse } from './request-logger';

function messagesToPrompt(messages: ChatCompletionRequest['messages']): string {
  if (!messages?.length) return '';
  return messages
    .map((m) => {
      const content =
        typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content ?? '');
      return `${m.role}: ${content}`;
    })
    .join('\n\n');
}

function chunkId(): string {
  return `cursor-${Date.now().toString(36)}`;
}

function sseChunk(
  id: string,
  model: string,
  delta: string,
  finishReason: string | null,
): string {
  return (
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: finishReason ? {} : { content: delta },
          finish_reason: finishReason,
        },
      ],
    })}\n\n`
  );
}

function openAiCompletion(
  id: string,
  model: string,
  content: string,
  usage: TokenUsage | null,
) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function sdkUsageToBilling(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
      }
    | undefined,
  promptEstimate: number,
  completionText: string,
): { usage: TokenUsage; cacheReadTokens: number } {
  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  const prompt = usage?.inputTokens ?? promptEstimate;
  const completion = usage?.outputTokens ?? estimateTokensFromText(completionText);
  return {
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion + cacheReadTokens,
    },
    cacheReadTokens,
  };
}

async function recordCursorUsage(
  adapter: CursorProvider,
  model: string,
  usage: TokenUsage,
  cacheReadTokens: number,
  requestCtx: CompletionRequestContext,
  opts: {
    requestBody: ChatCompletionRequest;
    status: number;
    stream: boolean;
    responseBody: unknown;
    error?: string;
  },
): Promise<void> {
  const pricing = adapter.getPricing(model);
  const dollars = computeCost(
    usage.prompt_tokens,
    usage.completion_tokens,
    pricing.inputPerMillion ?? appConfig.fallbackPricing.inputPerMillion,
    pricing.outputPerMillion ?? appConfig.fallbackPricing.outputPerMillion,
    cacheReadTokens,
    pricing.cacheReadPerMillion ?? 0,
  );

  await logCost({
    model,
    tokensIn: usage.prompt_tokens,
    tokensOut: usage.completion_tokens,
    dollars,
    provider: adapter.id,
    userRequestPreview: requestCtx.userRequestPreview,
    requestKb: requestCtx.requestKb,
  });

  await logRequestDump({
    provider: adapter.id,
    model,
    upstreamUrl: 'cursor-sdk',
    status: opts.status,
    stream: opts.stream,
    tokensIn: usage.prompt_tokens,
    tokensOut: usage.completion_tokens,
    dollars,
    requestBody: opts.requestBody,
    responseBody: opts.responseBody,
    requestCtx,
    error: opts.error,
  });
}

function agentOptions(adapter: CursorProvider, model: string) {
  return {
    apiKey: adapter.config.apiKey,
    model: parseCursorModelSelection(model),
    local: {
      cwd: adapter.config.cwd ?? process.cwd(),
      settingSources: [] as SettingSource[],
    },
  };
}

async function runNonStreaming(
  adapter: CursorProvider,
  model: string,
  prompt: string,
  res: Response,
  body: ChatCompletionRequest,
  requestCtx: CompletionRequestContext,
  promptEstimate: number,
  endpointPrefix: string,
): Promise<void> {
  const requestedModelName = String(body.model ?? '');
  const id = chunkId();
  logOutgoing({
    provider: adapter.id,
    url: 'cursor-sdk',
    stream: false,
    endpointPrefix,
    requestedModel: requestedModelName,
    effectiveModel: model,
  });

  try {
    const result = await Agent.prompt(prompt, agentOptions(adapter, model));
    const content = result.result ?? '';
    const billing = sdkUsageToBilling(result.usage, promptEstimate, content);
    const payload = openAiCompletion(id, model, content, billing.usage);

    logResponse({
      provider: adapter.id,
      status: result.status === 'error' ? 502 : 200,
      preview: content,
      stream: false,
      detail: result.status === 'error' ? 'cursor run failed' : undefined,
      endpointPrefix,
      requestedModel: requestedModelName,
      effectiveModel: model,
    });

    await recordCursorUsage(adapter, model, billing.usage, billing.cacheReadTokens, requestCtx, {
      requestBody: body,
      status: result.status === 'error' ? 502 : 200,
      stream: false,
      responseBody: payload,
      error: result.status === 'error' ? 'cursor run failed' : undefined,
    });

    if (result.status === 'error') {
      res.status(502).json({
        error: { message: 'Cursor agent run failed', type: 'proxy_error' },
      });
      return;
    }

    res.status(200).json(payload);
  } catch (err) {
    const message =
      err instanceof CursorAgentError
        ? `Cursor SDK: ${err.message}`
        : err instanceof Error
          ? err.message
          : 'Cursor SDK request failed';
    logProxyError({
      provider: adapter.id,
      endpointPrefix,
      requestedModel: requestedModelName,
      effectiveModel: model,
      message,
    });
    await recordCursorUsage(
      adapter,
      model,
      { prompt_tokens: promptEstimate, completion_tokens: 0, total_tokens: promptEstimate },
      0,
      requestCtx,
      {
        requestBody: body,
        status: 502,
        stream: false,
        responseBody: { error: message },
        error: message,
      },
    ).catch((err) => {
      console.error('[request-dump] recordCursorUsage failed (non-streaming):', (err as Error)?.message ?? String(err));
    });
    res.status(502).json({ error: { message, type: 'proxy_error' } });
  }
}

async function runStreaming(
  adapter: CursorProvider,
  model: string,
  prompt: string,
  res: Response,
  body: ChatCompletionRequest,
  requestCtx: CompletionRequestContext,
  promptEstimate: number,
  endpointPrefix: string,
): Promise<void> {
  const requestedModelName = String(body.model ?? '');
  const id = chunkId();
  logOutgoing({
    provider: adapter.id,
    url: 'cursor-sdk',
    stream: true,
    endpointPrefix,
    requestedModel: requestedModelName,
    effectiveModel: model,
  });

  let completionText = '';
  const agent = await Agent.create(agentOptions(adapter, model));

  try {
    const run = await agent.send(prompt);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    for await (const event of run.stream()) {
      if (event.type !== 'assistant') continue;
      for (const block of event.message.content) {
        if (block.type !== 'text' || !block.text) continue;
        completionText += block.text;
        res.write(sseChunk(id, model, block.text, null));
      }
    }

    const result = await run.wait();
    if (result.status === 'error') {
      res.write(
        sseChunk(id, model, '', 'stop') +
          `data: ${JSON.stringify({ error: { message: 'Cursor agent run failed', type: 'proxy_error' } })}\n\n`,
      );
      res.end();
      return;
    }

    res.write(sseChunk(id, model, '', 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();

    const billing = sdkUsageToBilling(result.usage, promptEstimate, completionText);
    logResponse({
      provider: adapter.id,
      status: 200,
      preview: completionText,
      stream: true,
      endpointPrefix,
      requestedModel: requestedModelName,
      effectiveModel: model,
    });
    await recordCursorUsage(adapter, model, billing.usage, billing.cacheReadTokens, requestCtx, {
      requestBody: body,
      status: 200,
      stream: true,
      responseBody: completionText,
    });
  } catch (err) {
    const message =
      err instanceof CursorAgentError
        ? `Cursor SDK: ${err.message}`
        : err instanceof Error
          ? err.message
          : 'Cursor SDK request failed';
    logProxyError({
      provider: adapter.id,
      endpointPrefix,
      requestedModel: requestedModelName,
      effectiveModel: model,
      message,
    });
    await recordCursorUsage(
      adapter,
      model,
      { prompt_tokens: promptEstimate, completion_tokens: 0, total_tokens: promptEstimate },
      0,
      requestCtx,
      {
        requestBody: body,
        status: 502,
        stream: true,
        responseBody: { error: message },
        error: message,
      },
    ).catch((err) => {
      console.error('[request-dump] recordCursorUsage failed (streaming):', (err as Error)?.message ?? String(err));
    });

    if (!res.headersSent) {
      res.status(502).json({ error: { message, type: 'proxy_error' } });
    } else {
      res.end();
    }
  } finally {
    await agent.close();
  }
}

export async function forwardCursorChatCompletion(
  adapter: CursorProvider,
  activeModel: string,
  body: ChatCompletionRequest,
  res: Response,
  endpointPrefix: string,
): Promise<void> {
  if (!adapter.config.apiKey) {
    res.status(503).json({
      error: {
        message: 'CURSOR_API_KEY is not configured',
        type: 'proxy_error',
      },
    });
    return;
  }

  const model = activeModel.trim() || adapter.resolveModel(body.model);
  const prompt = messagesToPrompt(body.messages);
  const requestCtx = captureRequestContext(body.messages);
  const promptEstimate = estimateTokensFromMessages(body.messages);

  if (body.stream) {
    await runStreaming(adapter, model, prompt, res, body, requestCtx, promptEstimate, endpointPrefix);
    return;
  }

  await runNonStreaming(
    adapter,
    model,
    prompt,
    res,
    body,
    requestCtx,
    promptEstimate,
    endpointPrefix,
  );
}
