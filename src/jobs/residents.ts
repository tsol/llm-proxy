import { appConfig } from '../config';
import {
  ensureLocalModelReady,
  getGpuStatus,
  modelKeysMatch,
  startComfy,
  stopComfy,
  unloadLmStudio,
} from '../services/gpu-resources';
import { listResidents } from './registry';

export interface ResidentState {
  key: string;
  family: 'comfyui' | 'lmstudio';
  up: boolean;
  idle_vram_mb: number;
  idle_ram_mb: number;
  last_used_at: number;
}

const lastUsed = new Map<string, number>();

export function touchResident(keys: string[]): void {
  const now = Date.now();
  for (const k of keys) lastUsed.set(k, now);
}

function idleFor(key: string, family: 'comfyui' | 'lmstudio'): {
  vram: number;
  ram: number;
} {
  const manifests = listResidents();
  const m = manifests.find((r) => r.id === family);
  return {
    vram: m?.idle_vram_mb ?? (family === 'comfyui' ? 3500 : appConfig.services.localLlmVramMb),
    ram: m?.idle_ram_mb ?? (family === 'comfyui' ? 6000 : 2000),
  };
}

export async function snapshotResidents(): Promise<ResidentState[]> {
  const status = await getGpuStatus();
  const out: ResidentState[] = [];
  if (status.comfy.running || status.comfy.api_reachable) {
    const idle = idleFor('comfyui', 'comfyui');
    out.push({
      key: 'comfyui',
      family: 'comfyui',
      up: true,
      idle_vram_mb: idle.vram,
      idle_ram_mb: idle.ram,
      last_used_at: lastUsed.get('comfyui') ?? 0,
    });
  }
  for (const inst of status.lmstudio.loaded) {
    const key = `lmstudio:${inst.model_key}`;
    const idle = idleFor(key, 'lmstudio');
    out.push({
      key,
      family: 'lmstudio',
      up: true,
      idle_vram_mb: idle.vram,
      idle_ram_mb: idle.ram,
      last_used_at: lastUsed.get(key) ?? 0,
    });
  }
  return out;
}

export function residentKeyMatches(required: string, actual: string): boolean {
  if (required === actual) return true;
  if (required === 'comfyui' || actual === 'comfyui') return required === actual;
  if (required.startsWith('lmstudio:') && actual.startsWith('lmstudio:')) {
    const reqModel = required.slice('lmstudio:'.length);
    const actModel = actual.slice('lmstudio:'.length);
    return modelKeysMatch(reqModel, actModel);
  }
  return false;
}

function parseLmKey(key: string): string | null {
  if (!key.startsWith('lmstudio:')) return null;
  return key.slice('lmstudio:'.length);
}

export async function ensureUp(
  key: string,
  opts?: { contextLength?: number; contextSteps?: number[] },
): Promise<void> {
  if (key === 'comfyui') {
    const result = await startComfy();
    if (!result.api_reachable) {
      throw new Error('ComfyUI API not reachable after start');
    }
    touchResident(['comfyui']);
    return;
  }
  const model = parseLmKey(key);
  if (!model) throw new Error(`Unknown resident key: ${key}`);
  await ensureLocalModelReady({
    model,
    context_length: opts?.contextLength,
    contextSteps: opts?.contextSteps,
    exclusive: false,
  });
  touchResident([key]);
}

export async function evict(key: string): Promise<void> {
  if (key === 'comfyui') {
    await stopComfy(false);
    return;
  }
  const model = parseLmKey(key);
  if (!model) {
    if (key === 'lmstudio' || key.startsWith('lmstudio')) {
      await unloadLmStudio();
    }
    return;
  }
  const status = await getGpuStatus();
  for (const inst of status.lmstudio.loaded) {
    if (modelKeysMatch(model, inst.model_key)) {
      await unloadLmStudio(inst.instance_id);
      return;
    }
  }
  await unloadLmStudio();
}
