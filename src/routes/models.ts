import { Router, type Request, type Response } from 'express';
import { listCatalogModels, resolveModelRoute } from '../catalog';
import {
  serializeCatalogModel,
  serializeCatalogModelDetail,
} from '../model-response';

function findCatalogModel(
  models: Awaited<ReturnType<typeof listCatalogModels>>,
  modelId: string,
) {
  const decoded = decodeURIComponent(modelId);
  return models.find(
    (m) =>
      m.id === modelId ||
      m.id === decoded ||
      m.upstream_id === modelId ||
      m.upstream_id === decoded,
  );
}

export const modelsRouter = Router();

modelsRouter.get('/models', async (_req: Request, res: Response) => {
  try {
    const data = await listCatalogModels();
    res.json({
      object: 'list',
      data: data.map((m) => serializeCatalogModel(m)),
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

modelsRouter.get('/models/:modelId', async (req: Request, res: Response) => {
  try {
    const modelId = Array.isArray(req.params.modelId)
      ? req.params.modelId[0]
      : req.params.modelId;
    const route = await resolveModelRoute(modelId);
    const data = await listCatalogModels({
      freshLocal: route?.provider === 'local',
    });
    const model = findCatalogModel(data, modelId);
    if (!model) {
      res.status(404).json({
        error: {
          message: `Model not found: ${modelId}`,
          type: 'invalid_request_error',
        },
      });
      return;
    }
    res.json(serializeCatalogModelDetail(model));
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to fetch model',
        type: 'proxy_error',
      },
    });
  }
});
