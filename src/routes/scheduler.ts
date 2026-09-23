import { Router, type Request, type Response } from 'express';
import { jobEvents } from '../jobs/events';
import { snapshot } from '../jobs/scheduler';

export const schedulerRouter = Router();

schedulerRouter.get('/scheduler', async (_req: Request, res: Response) => {
  res.json(await snapshot());
});

schedulerRouter.get('/scheduler/stream', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();

  let lastSent = 0;
  const push = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastSent < 500) return;
    lastSent = now;
    const data = await snapshot();
    res.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
  };

  await push();
  const interval = setInterval(() => void push(), 2000);
  const onSnap = () => void push();
  jobEvents.on('snapshot', onSnap);
  req.on('close', () => {
    clearInterval(interval);
    jobEvents.off('snapshot', onSnap);
  });
});
