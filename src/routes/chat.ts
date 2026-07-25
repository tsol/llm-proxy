import { Router, type Request, type Response } from 'express';
import type { ChatCompletionRequest } from '../types';
import { resolveModelRoute, refreshProviderLive, supportedModelIds } from '../catalog';
import { ensureLocalModelReady } from '../services/gpu-resources';
import { getProvider } from '../providers';
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
      model: String(body.model ?? ''),
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
      model: route.displayModel,
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
  });

  if (route.provider === 'local') {
    try {
      await ensureLocalModelReady({ model: route.upstreamModel });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'local model GPU prep failed';
      logProxyError({
        provider: route.provider,
        model: route.upstreamModel,
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
    );
    return;
  }

  await forwardChatCompletion(
    adapter,
    route.upstreamModel,
    body,
    req.headers,
    res,
  );
});
