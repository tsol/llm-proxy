import path from 'path';
import { Router, type Request, type Response } from 'express';
import { getJob, listJobs } from '../jobs/db';
import { jobEvents } from '../jobs/events';
import { resolveArtifact } from '../jobs/outputs';
import { cancelJob } from '../jobs/scheduler';
import { serializeJob } from '../jobs/serialize';
import type { JobStatus } from '../jobs/types';

export const jobsRouter = Router();

jobsRouter.get('/jobs', (req: Request, res: Response) => {
  const status = req.query.status as JobStatus | undefined;
  const service = req.query.service as string | undefined;
  const limit = Number(req.query.limit ?? 50);
  const rows = listJobs({ status, service, limit });
  res.json({ data: rows.map(serializeJob) });
});

jobsRouter.get('/jobs/:id', (req: Request, res: Response) => {
  const row = getJob(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: { message: 'Job not found' } });
    return;
  }
  res.json({ job: serializeJob(row) });
});

jobsRouter.delete('/jobs/:id', (req: Request, res: Response) => {
  const row = cancelJob(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: { message: 'Job not found' } });
    return;
  }
  res.json({ job: serializeJob(row) });
});

jobsRouter.get('/jobs/:id/events', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const row = getJob(id);
  if (!row) {
    res.status(404).json({ error: { message: 'Job not found' } });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();
  const send = (r: ReturnType<typeof getJob>) => {
    if (!r) return;
    res.write(`event: job\ndata: ${JSON.stringify(serializeJob(r))}\n\n`);
    if (['succeeded', 'failed', 'cancelled'].includes(r.status)) {
      res.end();
    }
  };
  send(row);
  const onJob = (updated: { id: string }) => {
    if (updated.id !== id) return;
    send(getJob(id));
  };
  jobEvents.on('job', onJob);
  req.on('close', () => jobEvents.off('job', onJob));
});

jobsRouter.get('/jobs/:id/artifacts/:filename', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const suffix = String(req.params.filename);
  const row = getJob(id);
  if (!row) {
    res.status(404).json({ error: { message: 'Job not found' } });
    return;
  }
  try {
    const file = resolveArtifact(row.outputs_dir, suffix);
    res.sendFile(path.resolve(file));
  } catch (err) {
    res.status(404).json({
      error: { message: err instanceof Error ? err.message : 'not found' },
    });
  }
});
