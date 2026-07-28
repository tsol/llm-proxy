import { Router, type Request, type Response } from 'express';
import type { ChatCompletionRequest, ProviderId } from '../types';
import { resolveModelRoute, refreshProviderLive, supportedModelIds } from '../catalog';
import { ensureLocalModelReady } from '../services/gpu-resources';
import { getProvider, allProviders, getProviderIds } from '../providers';
import { forwardChatCompletion } from '../services/forward';
import { forwardCursorChatCompletion } from '../services/cursor-forward';
import { CursorProvider } from '../providers/cursor';
import { captureRequestContext } from '../services/cost-logger';
import { logIncoming, logProxyError } from '../services/request-logger';
import {
  formatCapabilitiesError,
  messageInputModalities,
  unsupportedInputModalities,
} from '../model-capabilities';

export const chatRouter = Router();

chatRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const body = req.body as ChatCompletionRequest;
  const route = await resolveModelRoute(body.model);

  if (!route) {
    const supported = await supportedModelIds();
    logProxyError({
      provider: '?',
      endpointPrefix: 'root',
      requestedModel: String(body.model ?? ''),
      effectiveModel: String(body.model ?? ''),
      message: `unsupported model`,
    });
    res.status(400).json({
      error: {
        message: `unsupported model "${body.model ?? ''}"; supported models: ${supported.join(', ')}`,
        type: 'invalid_request_error',
        param: 'model',
      },
    });
    return;
  }

  const requestedModalities = messageInputModalities(body.messages);
  const blocked = unsupportedInputModalities(route.capabilities, requestedModalities);
  if (blocked.length > 0) {
    const message = formatCapabilitiesError(route.displayModel, blocked);
    logProxyError({
      provider: route.provider,
      endpointPrefix: 'root',
      requestedModel: String(body.model ?? ''),
      effectiveModel: route.displayModel,
      message,
    });
    res.status(400).json({
      error: {
        message,
        type: 'invalid_request_error',
        param: 'messages',
        code: 'unsupported_content_type',
      },
    });
    return;
  }

  const adapter = getProvider(route.provider);
  const requestCtx = captureRequestContext(body.messages);
  logIncoming({
    provider: route.provider,
    model: route.upstreamModel,
    stream: Boolean(body.stream),
    preview: requestCtx.userRequestPreview,
    endpointPrefix: 'root',
    requestedModel: String(body.model ?? ''),
  });

  if (route.provider === 'local') {
    try {
      await ensureLocalModelReady({ model: route.upstreamModel });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'local model GPU prep failed';
      logProxyError({
        provider: route.provider,
        endpointPrefix: 'root',
        requestedModel: String(body.model ?? ''),
        effectiveModel: route.upstreamModel,
        message,
      });
      res.status(503).json({
        error: {
          message,
          type: 'proxy_error',
          code: 'local_model_unavailable',
        },
      });
      return;
    }
    await refreshProviderLive('local');
  }

  if (route.provider === 'cursor') {
    await forwardCursorChatCompletion(
      adapter as CursorProvider,
      route.upstreamModel,
      body,
      res,
      'root',
    );
    return;
  }

  await forwardChatCompletion(
    adapter,
    route.upstreamModel,
    body,
    req.headers,
    res,
    'root',
  );
});

// ---- Per-provider router ---- //
// Mounted at /v1/:provider (e.g. /v1/deepseek/chat/completions)
// Bypasses catalog lookup — forces all requests through the named provider.

export const perProviderRouter = Router({ mergeParams: true });

const VALID_PROVIDER_IDS = new Set(getProviderIds());

perProviderRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const provider = req.params.provider as ProviderId;
  if (!VALID_PROVIDER_IDS.has(provider)) {
    res.status(400).json({ error: { message: `Unknown provider: ${provider}`, type: 'invalid_request_error' } });
    return;
  }
  const adapter = getProvider(provider);
  const body = req.body as ChatCompletionRequest;

  const model = adapter.resolveModel(body.model);

  if (provider === 'cursor') {
    await forwardCursorChatCompletion(adapter as CursorProvider, model, body, res, provider);
    return;
  }

  const requestCtx = captureRequestContext(body.messages);
  logIncoming({
    provider,
    model,
    stream: Boolean(body.stream),
    preview: requestCtx.userRequestPreview,
    endpointPrefix: provider,
    requestedModel: String(body.model ?? ''),
  });

  await forwardChatCompletion(adapter, model, body, req.headers, res, provider);
});

perProviderRouter.get('/models', async (req: Request, res: Response) => {
  const provider = req.params.provider as ProviderId;
  if (!VALID_PROVIDER_IDS.has(provider)) {
    res.status(400).json({ error: { message: `Unknown provider: ${provider}`, type: 'invalid_request_error' } });
    return;
  }
  const adapter = getProvider(provider);
  try {
    const result = await adapter.listModelsDetailed();
    const displayModels = result.models.map((m) => ({
      id: m.id,
      object: m.object,
      created: m.created,
      owned_by: m.owned_by,
      ...(m.context_length ? { context_length: m.context_length } : {}),
      ...(m.max_tokens ? { max_tokens: m.max_tokens } : {}),
    }));
    res.json({ object: 'list', data: displayModels });
  } catch {
    res.status(502).json({ error: { message: `Failed to fetch models for ${provider}`, type: 'proxy_error' } });
  }
});
