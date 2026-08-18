import { Router, type Request, type Response } from 'express';
import { providerConfigs } from '../config';
import { resolveModelQuirk } from '../providers/metadata';
import {
  ensureLocalModelReady,
  getGpuStatus,
  loadLmStudio,
  setGpuMode,
  startComfy,
  stopComfy,
  unloadLmStudio,
  type GpuMode,
} from '../services/gpu-resources';

export const gpuRouter = Router();

gpuRouter.get('/gpu/status', async (_req: Request, res: Response) => {
  try {
    const status = await getGpuStatus();
    res.json(status);
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to read GPU status',
        type: 'proxy_error',
      },
    });
  }
});

gpuRouter.post('/gpu/lmstudio/unload', async (req: Request, res: Response) => {
  try {
    const instanceId = String(req.body?.instance_id ?? '').trim() || undefined;
    const force = req.body?.force === true;
    const result = await unloadLmStudio(instanceId, force);
    const status = await getGpuStatus();
    res.json({ ok: true, ...result, status });
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'LM Studio unload failed',
        type: 'proxy_error',
      },
    });
  }
});

gpuRouter.post('/gpu/lmstudio/load', async (req: Request, res: Response) => {
  try {
    const model = String(req.body?.model ?? '').trim() || undefined;
    const contextLength = Number(req.body?.context_length);
    const result = await loadLmStudio({
      model,
      context_length: Number.isFinite(contextLength) ? contextLength : undefined,
    });
    const status = await getGpuStatus();
    res.json({ ok: true, ...result, status });
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'LM Studio load failed',
        type: 'proxy_error',
      },
    });
  }
});

gpuRouter.post('/gpu/comfy/start', async (_req: Request, res: Response) => {
  try {
    const result = await startComfy();
    const status = await getGpuStatus();
    res.json({ ok: true, ...result, status });
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'ComfyUI start failed',
        type: 'proxy_error',
      },
    });
  }
});

gpuRouter.post('/gpu/comfy/stop', async (req: Request, res: Response) => {
  try {
    const force = req.body?.force === true;
    const result = await stopComfy(force);
    const status = await getGpuStatus();
    res.json({ ok: true, ...result, status });
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'ComfyUI stop failed',
        type: 'proxy_error',
      },
    });
  }
});

gpuRouter.post('/gpu/local/ensure', async (req: Request, res: Response) => {
  try {
    const model =
      String(req.body?.model ?? '').trim() || providerConfigs.local.defaultModel;
    const contextLength = Number(req.body?.context_length);
    const rawSteps = req.body?.context_steps;
    const contextSteps = Array.isArray(rawSteps)
      ? rawSteps.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : undefined;
    const exclusive =
      req.body?.exclusive === true
        ? true
        : req.body?.exclusive === false
          ? false
          : undefined;
    const quirk = resolveModelQuirk(model, providerConfigs.local.modelQuirks);
    const result = await ensureLocalModelReady({
      model,
      context_length: Number.isFinite(contextLength)
        ? contextLength
        : quirk?.contextLength,
      contextSteps: contextSteps && contextSteps.length > 0
        ? contextSteps
        : quirk?.contextSteps,
      exclusive: exclusive ?? quirk?.gpuPrep?.exclusive === true,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({
      error: {
        message:
          err instanceof Error ? err.message : 'Local model ensure failed',
        type: 'proxy_error',
      },
    });
  }
});

gpuRouter.post('/gpu/mode', async (req: Request, res: Response) => {
  const mode = String(req.body?.mode ?? '').trim() as GpuMode;
  if (mode !== 'llm' && mode !== 'images') {
    res.status(400).json({
      error: {
        message: 'mode must be "llm" or "images"',
        type: 'invalid_request_error',
      },
    });
    return;
  }

  try {
    const force = req.body?.force === true;
    const result = await setGpuMode(mode, force);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'GPU mode switch failed',
        type: 'proxy_error',
      },
    });
  }
});
