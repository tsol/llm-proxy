import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { appConfig } from '../config';
import { getService } from './registry';
import { getSettings } from './settings-store';
import { resolveArtifact } from './outputs';
import { updateJob, insertStat } from './db';
import { emitJobUpdate } from './events';
import { readGpu, sampleProcessTree } from './resources';
import type { JobRow, JobResultPayload } from './types';

const cancelTokens = new Map<string, () => void>();

export function registerCancel(jobId: string, fn: () => void): void {
  cancelTokens.set(jobId, fn);
}

export function triggerCancel(jobId: string): boolean {
  const fn = cancelTokens.get(jobId);
  if (!fn) return false;
  fn();
  return true;
}

export async function runExecJob(job: JobRow): Promise<void> {
  const svc = getService(job.service_id);
  if (!svc) {
    const failed = updateJob(job.id, {
      status: 'failed',
      error: 'service not found',
      finished_at: Date.now(),
    });
    if (failed) emitJobUpdate(failed);
    return;
  }

  const settings = getSettings(svc);
  const settingsPath = path.join(job.outputs_dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const logPath = path.join(job.outputs_dir, 'job.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const env = {
    ...process.env,
    JOB_ID: job.id,
    JOB_DIR: job.outputs_dir,
    JOB_INPUT: path.join(job.outputs_dir, 'input.json'),
    JOB_SETTINGS: settingsPath,
    SERVICE_DIR: svc.dir,
    PROXY_URL: `http://127.0.0.1:${appConfig.port}`,
    COMFY_API_URL: appConfig.gpu.comfyApiUrl,
    LMSTUDIO_URL: appConfig.gpu.lmStudioNativeUrl,
  };

  let resultPayload: JobResultPayload | null = null;
  let peakVram = 0;
  let peakRam = 0;
  let childPid: number | null = null;
  let killed = false;

  const child = spawn(svc.entry[0], svc.entry.slice(1), {
    cwd: svc.dir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  childPid = child.pid ?? null;

  const timeoutMs = svc.timeout_sec * 1000;
  const timeout = setTimeout(() => {
    killed = true;
    tryKill(childPid);
  }, timeoutMs);

  cancelTokens.set(job.id, () => {
    killed = true;
    tryKill(childPid);
  });

  const sampleTimer = setInterval(async () => {
    if (!childPid) return;
    const gpu = await readGpu();
    if (gpu) peakVram = Math.max(peakVram, gpu.used_mb);
    peakRam = Math.max(peakRam, await sampleProcessTree(childPid));
  }, 2000);

  function tryKill(pid: number | null): void {
    if (!pid) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid!, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 10_000);
  }

  child.stdout?.on('data', (buf: Buffer) => {
    const text = buf.toString();
    logStream.write(text);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const ev = JSON.parse(trimmed) as Record<string, unknown>;
        if (ev.type === 'progress') {
          const row = updateJob(job.id, {
            progress: Number(ev.ratio ?? 0),
            stage: String(ev.stage ?? ''),
            message: String(ev.message ?? ''),
          });
          if (row) emitJobUpdate(row);
        } else if (ev.type === 'result') {
          resultPayload = {
            outputs: (ev.outputs as JobResultPayload['outputs']) ?? [],
            data: (ev.data as Record<string, unknown>) ?? {},
          };
        }
      } catch {
        /* not json */
      }
    }
  });

  child.stderr?.on('data', (buf: Buffer) => {
    logStream.write(buf);
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
  });

  clearTimeout(timeout);
  clearInterval(sampleTimer);
  cancelTokens.delete(job.id);
  logStream.end();

  const finishedAt = Date.now();
  const startedAt = job.started_at ?? finishedAt;

  if (killed && exitCode !== 0) {
    const row = updateJob(job.id, {
      status: 'cancelled',
      finished_at: finishedAt,
      error: 'cancelled or timeout',
    });
    if (row) emitJobUpdate(row);
    return;
  }

  if (exitCode !== 0 || resultPayload === null) {
    const errTail = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8').slice(-2000)
      : 'no result event';
    const row = updateJob(job.id, {
      status: 'failed',
      finished_at: finishedAt,
      error: errTail || 'no result event',
    });
    if (row) emitJobUpdate(row);
    return;
  }

  const done: JobResultPayload = resultPayload;
  for (const out of done.outputs) {
    resolveArtifact(job.outputs_dir, out.path);
  }
  const resultJson = JSON.stringify(done);
  fs.writeFileSync(path.join(job.outputs_dir, 'result.json'), resultJson);
  const row = updateJob(job.id, {
    status: 'succeeded',
    finished_at: finishedAt,
    progress: 1,
    result_json: resultJson,
  });
  if (row) emitJobUpdate(row);

  insertStat({
    job_id: job.id,
    service_id: job.service_id,
    duration_sec: (finishedAt - startedAt) / 1000,
    peak_vram_mb: peakVram,
    peak_ram_mb: peakRam,
    finished_at: finishedAt,
  });
}
