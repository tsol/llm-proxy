import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import { appConfig } from '../config';
import { admit, type RunningItem } from './admission';
import {
  getJob,
  insertJob,
  listJobs,
  medianDuration,
  newJobId,
  recoverOnStartup,
  updateJob,
} from './db';
import { jobEvents, emitJobUpdate } from './events';
import { jobDir } from './outputs';
import { getService } from './registry';
import { capacity, readGpu } from './resources';
import {
  ensureUp,
  evict,
  snapshotResidents,
  touchResident,
  type ResidentState,
} from './residents';
import { runExecJob, triggerCancel } from './runner-exec';
import { serializeJob } from './serialize';
import type { JobRow, PriorityClass, ResourceVector } from './types';

interface QueueItem {
  key: string;
  kind: 'service' | 'llm';
  serviceId: string;
  priorityClass: PriorityClass;
  principal: string;
  resources: ResourceVector;
  requires: string[];
  evicts: string[];
  shared: boolean;
  estimateSec: number;
  createdAt: number;
  notBefore?: number;
  preview: string;
  attempts: number;
  start: (evicted: string[]) => Promise<void>;
  onAdmit?: () => void;
  onFail?: (reason: string) => void;
}

interface RunningEntry extends RunningItem {
  kind: 'service' | 'llm';
  release?: () => void;
}

const queue: QueueItem[] = [];
const running = new Map<string, RunningEntry>();
let gpuPreparing = false;
let ticking = false;
let timer: NodeJS.Timeout | null = null;
let llmSeq = 0;

const waiters = new Map<string, Array<(row: JobRow) => void>>();

function principalWeight(principal: string): number {
  try {
    const p = path.join(appConfig.services.proxyRoot, 'store', 'principals.json');
    if (!fs.existsSync(p)) return 0;
    const map = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, number>;
    return Number(map[principal] ?? 0);
  } catch {
    return 0;
  }
}

function scoreItem(item: QueueItem, residents: ResidentState[]): number {
  const CLASS = { interactive: 100, normal: 50, batch: 10 };
  const allUp = item.requires.every((req) =>
    residents.some((r) => r.up && (req === r.key || req.startsWith('lmstudio:') && r.key.startsWith('lmstudio:'))),
  );
  return (
    CLASS[item.priorityClass] +
    principalWeight(item.principal) +
    Math.floor((Date.now() - item.createdAt) / 30_000) +
    (allUp ? 20 : 0)
  );
}

function notifyWaiters(row: JobRow): void {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(row.status);
  if (!terminal) return;
  const list = waiters.get(row.id);
  if (!list) return;
  waiters.delete(row.id);
  for (const fn of list) fn(row);
}

function finishRunning(key: string, holds: string[]): void {
  running.delete(key);
  touchResident(holds);
  void tick();
}

export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    if (queue.length === 0) return;

    const residents = await snapshotResidents();
    const cap = await capacity();
    const now = Date.now();

    const sorted = [...queue].sort((a, b) => {
      const sa = scoreItem(a, residents);
      const sb = scoreItem(b, residents);
      if (sb !== sa) return sb - sa;
      return a.createdAt - b.createdAt;
    });

    let firstBlocked: QueueItem | null = null;
    let blockedUntil = Infinity;

    const runningList = [...running.values()];

    for (const item of sorted) {
      if (item.notBefore && item.notBefore > now) continue;
      if (gpuPreparing && item.resources.vram_mb > 0) continue;

      const decision = admit({
        capacity: cap,
        running: runningList,
        residents,
        job: {
          resources: item.resources,
          requires: item.requires,
          evicts: item.evicts,
          shared: item.shared,
        },
      });

      if (!decision.ok) {
        if (!firstBlocked) {
          firstBlocked = item;
          blockedUntil = Math.min(
            ...runningList.map((r) => r.etaAt),
            Infinity,
          );
        }
        if (item.kind === 'service') {
          const row = updateJob(item.key, { wait_reason: decision.reason });
          if (row) emitJobUpdate(row);
        }
        continue;
      }

      if (
        firstBlocked &&
        item.resources.vram_mb > 0 &&
        now + item.estimateSec * 1000 > blockedUntil
      ) {
        continue;
      }

      const idx = queue.indexOf(item);
      if (idx >= 0) queue.splice(idx, 1);

      const etaAt = now + item.estimateSec * 1000;
      const entry: RunningEntry = {
        key: item.key,
        resources: decision.absorbed ? { vram_mb: 0, ram_mb: 0, cpu: 0 } : item.resources,
        holds: item.requires,
        shared: item.shared,
        gpu: item.resources.vram_mb > 0,
        etaAt,
        kind: item.kind,
      };
      running.set(item.key, entry);
      runningList.push(entry);

      if (item.resources.vram_mb > 0 && !decision.absorbed) {
        gpuPreparing = true;
      }

      void item.start(decision.evict).finally(() => {
        gpuPreparing = false;
        void tick();
      });
    }
  } finally {
    ticking = false;
  }
}

async function prepareServiceJob(jobId: string, evicted: string[]): Promise<void> {
  const job = getJob(jobId);
  const svc = job ? getService(job.service_id) : undefined;
  if (!job || !svc) return;

  try {
    updateJob(jobId, { status: 'preparing', wait_reason: null });
    emitJobUpdate(getJob(jobId)!);

    for (const key of evicted) {
      await evict(key);
    }
    for (const req of svc.residents.requires) {
      await ensureUp(req);
    }

    const minFree = svc.resources.min_free_vram_mb;
    if (minFree !== undefined) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const gpu = await readGpu();
        if (gpu && gpu.free_mb >= minFree) break;
        await sleep(1000);
      }
      const gpu = await readGpu();
      if (!gpu || gpu.free_mb < minFree) {
        requeueJob(jobId, 'external VRAM usage');
        return;
      }
    }

    const row = updateJob(jobId, { status: 'running', started_at: Date.now() });
    if (row) emitJobUpdate(row);
    await runExecJob(row!);
    const finalRow = getJob(jobId);
    if (finalRow) {
      emitJobUpdate(finalRow);
      notifyWaiters(finalRow);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const row = updateJob(jobId, {
      status: 'failed',
      error: msg,
      finished_at: Date.now(),
    });
    if (row) {
      emitJobUpdate(row);
      notifyWaiters(row);
    }
  } finally {
    const holds = svc?.residents.requires ?? [];
    finishRunning(jobId, holds);
  }
}

function requeueJob(jobId: string, reason: string): void {
  const job = getJob(jobId);
  const svc = job ? getService(job.service_id) : undefined;
  if (!job || !svc) return;

  const item = queue.find((q) => q.key === jobId);
  const attempts = (item?.attempts ?? 0) + 1;
  if (attempts >= 5) {
    const row = updateJob(jobId, {
      status: 'failed',
      error: reason,
      finished_at: Date.now(),
    });
    if (row) emitJobUpdate(row);
    finishRunning(jobId, svc.residents.requires);
    return;
  }

  running.delete(jobId);
  updateJob(jobId, { status: 'queued', wait_reason: reason });
  emitJobUpdate(getJob(jobId)!);

  const resources = JSON.parse(job.resources_json) as ResourceVector;
  queue.push({
    key: jobId,
    kind: 'service',
    serviceId: job.service_id,
    priorityClass: job.priority_class,
    principal: job.principal,
    resources,
    requires: svc.residents.requires,
    evicts: svc.residents.evicts,
    shared: false,
    estimateSec: job.estimate_sec,
    createdAt: job.created_at,
    notBefore: Date.now() + 30_000,
    preview: job.service_id,
    attempts,
    start: (evicted) => prepareServiceJob(jobId, evicted),
  });
  void tick();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function estimateFor(serviceId: string): number {
  const med = medianDuration(serviceId);
  if (med !== null) return med;
  const svc = getService(serviceId);
  return svc?.estimate.duration_sec ?? 60;
}

export function startScheduler(): void {
  const queued = recoverOnStartup();
  for (const job of queued) {
    enqueueExistingJob(job);
  }
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), appConfig.services.tickMs);
  void tick();
}

function enqueueExistingJob(job: JobRow): void {
  const svc = getService(job.service_id);
  if (!svc) return;
  const resources = JSON.parse(job.resources_json) as ResourceVector;
  queue.push({
    key: job.id,
    kind: 'service',
    serviceId: job.service_id,
    priorityClass: job.priority_class,
    principal: job.principal,
    resources,
    requires: svc.residents.requires,
    evicts: svc.residents.evicts,
    shared: false,
    estimateSec: job.estimate_sec,
    createdAt: job.created_at,
    preview: job.service_id,
    attempts: 0,
    start: (evicted) => prepareServiceJob(job.id, evicted),
  });
}

export function submitJob(
  serviceId: string,
  opts: {
    input: Record<string, unknown>;
    priority?: PriorityClass;
    principal?: string;
  },
): JobRow {
  const svc = getService(serviceId);
  if (!svc) throw new Error(`Unknown service: ${serviceId}`);
  if (svc.kind !== 'exec') throw new Error(`Service ${serviceId} does not run GPU jobs`);

  const ajv = new Ajv({ useDefaults: true, coerceTypes: true, allErrors: true });
  const validate = ajv.compile(svc.input_schema);
  if (!validate(opts.input)) {
    throw new Error(ajv.errorsText(validate.errors));
  }

  const id = newJobId();
  const outDir = jobDir(serviceId, id);
  fs.writeFileSync(path.join(outDir, 'input.json'), JSON.stringify(opts.input, null, 2));

  const estimate = estimateFor(serviceId);
  const row = insertJob({
    id,
    service_id: serviceId,
    status: 'queued',
    priority_class: opts.priority ?? svc.priority_default,
    principal: opts.principal ?? 'anonymous',
    input_json: JSON.stringify(opts.input),
    resources_json: JSON.stringify(svc.resources),
    estimate_sec: estimate,
    created_at: Date.now(),
    outputs_dir: outDir,
  });

  queue.push({
    key: id,
    kind: 'service',
    serviceId,
    priorityClass: row.priority_class,
    principal: row.principal,
    resources: svc.resources,
    requires: svc.residents.requires,
    evicts: svc.residents.evicts,
    shared: false,
    estimateSec: estimate,
    createdAt: row.created_at,
    preview: String(opts.input.prompt ?? serviceId).slice(0, 80),
    attempts: 0,
    start: (evicted) => prepareServiceJob(id, evicted),
  });
  emitJobUpdate(row);
  void tick();
  return row;
}

export function waitForJob(id: string, sec: number): Promise<JobRow> {
  const existing = getJob(id);
  if (existing && ['succeeded', 'failed', 'cancelled'].includes(existing.status)) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    const list = waiters.get(id) ?? [];
    list.push(resolve);
    waiters.set(id, list);
    setTimeout(() => {
      const row = getJob(id);
      if (row) resolve(row);
    }, sec * 1000);
  });
}

export function cancelJob(id: string): JobRow | undefined {
  const idx = queue.findIndex((q) => q.key === id);
  if (idx >= 0) {
    queue.splice(idx, 1);
    const row = updateJob(id, { status: 'cancelled', finished_at: Date.now() });
    if (row) emitJobUpdate(row);
    return row;
  }
  if (running.has(id)) {
    triggerCancel(id);
    const row = updateJob(id, { status: 'cancelled', finished_at: Date.now() });
    if (row) emitJobUpdate(row);
    return row;
  }
  return undefined;
}

export interface LlmEnqueueOpts {
  model: string;
  preview: string;
  principal?: string;
  resources: ResourceVector;
  requires: string[];
  evicts: string[];
  shared: boolean;
  estimateSec: number;
  contextLength?: number;
  contextSteps?: number[];
  onClientClose: () => boolean;
  timeoutMs: number;
}

export function acquireLlmSlot(opts: LlmEnqueueOpts): Promise<{ release: () => void }> {
  return new Promise((resolve, reject) => {
    const key = `llm_${++llmSeq}`;
    let released = false;
    let settled = false;
    let clientTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const release = (): void => {
      if (released) return;
      released = true;
      if (clientTimer) clearInterval(clientTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const idx = queue.findIndex((q) => q.key === key);
      if (idx >= 0) queue.splice(idx, 1);
      finishRunning(key, opts.requires);
    };

    const settleBusy = (etaSec?: number): void => {
      if (settled) return;
      settled = true;
      release();
      reject(Object.assign(new Error('gpu_busy'), { code: 'gpu_busy', etaSec }));
    };

    const runningList = [...running.values()];
    const longGpu = runningList.filter(
      (r) => r.gpu && r.kind === 'service',
    );
    if (longGpu.length > 0) {
      const remaining = Math.min(...longGpu.map((r) => r.etaAt - Date.now()));
      if (remaining > appConfig.services.localLlmMaxWaitSec * 1000) {
        settleBusy(remaining / 1000);
        return;
      }
    }

    const item: QueueItem = {
      key,
      kind: 'llm',
      serviceId: 'llm_local',
      priorityClass: 'interactive',
      principal: opts.principal ?? 'anonymous',
      resources: opts.resources,
      requires: opts.requires,
      evicts: opts.evicts,
      shared: opts.shared,
      estimateSec: opts.estimateSec,
      createdAt: Date.now(),
      preview: opts.preview,
      attempts: 0,
      start: async (evicted) => {
        try {
          for (const k of evicted) await evict(k);
          for (const req of opts.requires) {
            if (req.startsWith('lmstudio:')) {
              await ensureUp(req, {
                contextLength: opts.contextLength,
                contextSteps: opts.contextSteps,
              });
            } else {
              await ensureUp(req);
            }
          }
          if (settled) return;
          settled = true;
          resolve({ release });
        } catch {
          settleBusy();
        }
      },
    };

    queue.push(item);
    void tick();

    timeoutTimer = setTimeout(() => {
      if (settled || running.has(key)) return;
      settleBusy();
    }, opts.timeoutMs);

    clientTimer = setInterval(() => {
      if (opts.onClientClose()) {
        if (!settled) {
          settled = true;
          release();
          reject(Object.assign(new Error('client-closed'), { code: 'client-closed' }));
        }
      }
    }, 500);
  });
}

export async function snapshot(): Promise<Record<string, unknown>> {
  const residents = await snapshotResidents();
  const cap = await capacity();
  const gpu = await readGpu();
  const queued = queue.map((q) => ({
    key: q.key,
    kind: q.kind,
    serviceId: q.serviceId,
    score: scoreItem(q, residents),
    preview: q.preview,
    wait_reason: getJob(q.key)?.wait_reason ?? null,
    createdAt: q.createdAt,
  }));
  const runningArr = [...running.values()].map((r) => ({
    key: r.key,
    holds: r.holds,
    etaAt: r.etaAt,
    kind: r.kind,
  }));
  return {
    capacity: cap,
    gpu,
    residents,
    running: runningArr,
    queued,
    recent: listJobs({ limit: 30 }).map((row) => serializeJob(row)),
  };
}

jobEvents.on('snapshot', () => {
  /* SSE hooks in routes */
});
