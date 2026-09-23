import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import { promisify } from 'util';
import { appConfig } from '../config';
import type { ResourceVector } from './types';

const execFileAsync = promisify(execFile);

let cache: { at: number; gpu: GpuSample | null; mem: MemSample | null } | null = null;

export interface GpuSample {
  total_mb: number;
  used_mb: number;
  free_mb: number;
}

export interface MemSample {
  total_mb: number;
  available_mb: number;
}

async function readGpuUncached(): Promise<GpuSample | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=memory.total,memory.used,memory.free',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 8000 },
    );
    const line = stdout.trim().split('\n')[0];
    const [total, used, free] = line.split(',').map((s) => Number(s.trim()));
    if (!Number.isFinite(total)) return null;
    return {
      total_mb: total,
      used_mb: used,
      free_mb: free,
    };
  } catch {
    return null;
  }
}

function readMemUncached(): MemSample {
  const raw = fs.readFileSync('/proc/meminfo', 'utf8');
  let totalKb = 0;
  let availKb = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('MemTotal:')) totalKb = Number(line.split(/\s+/)[1]);
    if (line.startsWith('MemAvailable:')) availKb = Number(line.split(/\s+/)[1]);
  }
  return {
    total_mb: Math.round(totalKb / 1024),
    available_mb: Math.round(availKb / 1024),
  };
}

export async function readGpu(): Promise<GpuSample | null> {
  const now = Date.now();
  if (cache && now - cache.at < 1000) return cache.gpu;
  const gpu = await readGpuUncached();
  const mem = readMemUncached();
  cache = { at: now, gpu, mem };
  return gpu;
}

export async function readMem(): Promise<MemSample> {
  const now = Date.now();
  if (cache && now - cache.at < 1000) return cache.mem!;
  const gpu = await readGpuUncached();
  const mem = readMemUncached();
  cache = { at: now, gpu, mem };
  return mem;
}

export async function capacity(): Promise<ResourceVector> {
  const gpu = await readGpu();
  const mem = await readMem();
  const vramTotal = gpu?.total_mb ?? 0;
  const ramTotal = mem.total_mb;
  return {
    vram_mb: Math.max(0, vramTotal - appConfig.services.vramReserveMb),
    ram_mb: Math.max(0, ramTotal - appConfig.services.ramReserveMb),
    cpu: os.cpus().length,
  };
}

export async function sampleProcessTree(pid: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-e', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss='],
      { timeout: 5000 },
    );
    const rows: { pid: number; ppid: number; rss: number }[] = [];
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      rows.push({
        pid: Number(parts[0]),
        ppid: Number(parts[1]),
        rss: Number(parts[2]),
      });
    }
    const children = new Map<number, number[]>();
    for (const r of rows) {
      if (!children.has(r.ppid)) children.set(r.ppid, []);
      children.get(r.ppid)!.push(r.pid);
    }
    const stack = [pid];
    const seen = new Set<number>();
    let rssKb = 0;
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      const row = rows.find((r) => r.pid === p);
      if (row) rssKb += row.rss;
      for (const c of children.get(p) ?? []) stack.push(c);
    }
    return Math.round(rssKb / 1024);
  } catch {
    return 0;
  }
}
