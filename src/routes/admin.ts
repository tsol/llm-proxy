import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { listCatalogModels, refreshCatalog, resolveModelRoute, getProviderStates } from '../catalog';
import { getDefaultSnapshot, setDefault } from '../default-model';
import { getProvider, providerIds, allProviders } from '../providers';
import { serializeCatalogModelDetail } from '../model-response';
import { getLiveQuota } from '../services/rate-limit-tracker';
import { concurrencySnapshot, updateAliasChainConfig } from '../services/concurrency-queue';
import { getAliasGroups } from '../services/alias-store';

export const adminRouter = Router();

adminRouter.get('/router/status', async (_req: Request, res: Response) => {
  const snapshot = getDefaultSnapshot();
  const route = await resolveModelRoute(snapshot.model);
  res.json({
    default_model: snapshot.model,
    provider: route?.provider ?? null,
    routing: 'per-request-model',
    provider_states: getProviderStates(),
  });
});

adminRouter.get('/router/queue', (_req: Request, res: Response) => {
  const groups = getAliasGroups('kimi');
  if (groups) {
    updateAliasChainConfig(groups, allProviders());
  }
  res.json(concurrencySnapshot());
});

adminRouter.get('/queue', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(fs.readFileSync(path.join(__dirname, '..', 'public', 'queue.html'), 'utf8'));
});

adminRouter.get('/router/providers', (_req: Request, res: Response) => {
  res.json({
    providers: providerIds().map((id) => {
      const adapter = getProvider(id);
      return {
        id,
        displayOrder: adapter.config.displayOrder ?? 99,
        defaultModel: adapter.config.defaultModel,
        defaultContextLength: adapter.config.defaultContextLength,
        baseUrl: adapter.config.baseUrl,
        rateLimits: adapter.config.rateLimits ?? {},
        liveQuota: getLiveQuota(id) ?? undefined,
      };
    }),
  });
});

adminRouter.get('/router/models', async (_req: Request, res: Response) => {
  try {
    const models = await listCatalogModels();
    const byProvider = new Map<string, typeof models>();
    for (const m of models) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    res.json({
      provider_states: getProviderStates(),
      providers: [...byProvider.entries()].map(([provider, items]) => ({
        provider,
        models: items.map((m) => serializeCatalogModelDetail(m)),
      })),
    });
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to list models',
        type: 'proxy_error',
      },
    });
  }
});

adminRouter.post('/router/refresh', async (_req: Request, res: Response) => {
  try {
    await refreshCatalog(true);
    res.json({ ok: true, message: 'Model catalog refreshed' });
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Refresh failed',
        type: 'proxy_error',
      },
    });
  }
});

/** Set Hermes default model (does not affect per-request routing). */
adminRouter.post('/router/default', (req: Request, res: Response) => {
  const model = String(req.body?.model ?? '').trim();
  if (!model) {
    res.status(400).json({ ok: false, message: 'Missing model' });
    return;
  }
  const snapshot = setDefault(model);
  res.json({ ok: true, message: `Default model set to ${model}`, ...snapshot });
});

/** Legacy alias: sets default model only. */
adminRouter.post('/router/switch', (req: Request, res: Response) => {
  const model = String(req.body?.model ?? '').trim();
  if (!model) {
    res.status(400).json({ ok: false, message: 'Missing model (target/provider ignored; route by model id)' });
    return;
  }
  const snapshot = setDefault(model);
  res.json({
    ok: true,
    applied: true,
    message: `Default model set to ${model}`,
    state: { model: snapshot.model, provider: null },
  });
});
