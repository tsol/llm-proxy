import { Router, type Request, type Response } from 'express';
import { getService, listServices, reloadRegistry } from '../jobs/registry';
import { getSettings, putSettings } from '../jobs/settings-store';
import { submitJob, waitForJob } from '../jobs/scheduler';
import { serializeJob } from '../jobs/serialize';
import type { PriorityClass } from '../jobs/types';

export const servicesRouter = Router();

servicesRouter.get('/services', (_req: Request, res: Response) => {
  const items = listServices().map((s) => ({
    id: s.id,
    kind: s.kind,
    title: s.title,
    description: s.description,
    version: s.version,
    mcp_url: s.external?.mcp_url ?? null,
    ui_url: s.external?.ui_url ?? null,
    health: s.external?.health ?? null,
    resources: s.resources,
    residents: s.residents,
    estimate_sec: s.estimate.duration_sec,
    priority_default: s.priority_default,
    input_schema: s.input_schema,
    has_settings: Boolean(s.settingsSchema),
    has_custom_ui: s.hasCustomUi,
  }));
  res.json({ data: items });
});

servicesRouter.post('/services/reload', (_req: Request, res: Response) => {
  res.json(reloadRegistry());
});

servicesRouter.get('/services/:id', (req: Request, res: Response) => {
  const svc = getService(String(req.params.id));
  if (!svc) {
    res.status(404).json({ error: { message: 'Service not found' } });
    return;
  }
  res.json({
    id: svc.id,
    kind: svc.kind,
    title: svc.title,
    description: svc.description,
    version: svc.version,
    mcp_url: svc.external?.mcp_url ?? null,
    ui_url: svc.external?.ui_url ?? null,
    health: svc.external?.health ?? null,
    resources: svc.resources,
    residents: svc.residents,
    estimate_sec: svc.estimate.duration_sec,
    priority_default: svc.priority_default,
    input_schema: svc.input_schema,
    has_settings: Boolean(svc.settingsSchema),
    has_custom_ui: svc.hasCustomUi,
  });
});

servicesRouter.get('/services/:id/settings', (req: Request, res: Response) => {
  const svc = getService(String(req.params.id));
  if (!svc) {
    res.status(404).json({ error: { message: 'Service not found' } });
    return;
  }
  res.json({ schema: svc.settingsSchema, values: getSettings(svc) });
});

servicesRouter.put('/services/:id/settings', (req: Request, res: Response) => {
  const svc = getService(String(req.params.id));
  if (!svc) {
    res.status(404).json({ error: { message: 'Service not found' } });
    return;
  }
  const result = putSettings(svc, req.body as Record<string, unknown>);
  if (!result.ok) {
    res.status(400).json({ error: { message: result.error } });
    return;
  }
  res.json({ values: result.values });
});

servicesRouter.post('/services/:id/jobs', async (req: Request, res: Response) => {
  const svc = getService(String(req.params.id));
  if (!svc) {
    res.status(404).json({ error: { message: 'Service not found' } });
    return;
  }
  const input = (req.body?.input ?? req.body) as Record<string, unknown>;
  const priority = req.body?.priority as PriorityClass | undefined;
  const principal =
    String(req.body?.principal ?? '').trim() ||
    String(req.headers['x-principal'] ?? '').trim() ||
    'anonymous';
  const waitSec = Number(req.body?.wait_sec ?? 0);

  try {
    let row = submitJob(svc.id, { input, priority, principal });
    if (waitSec > 0) {
      row = await waitForJob(row.id, waitSec);
    }
    const payload = serializeJob(row);
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(row.status);
    res.status(terminal ? 200 : 202).json({ job: payload });
  } catch (err) {
    res.status(400).json({
      error: { message: err instanceof Error ? err.message : 'submit failed' },
    });
  }
});
