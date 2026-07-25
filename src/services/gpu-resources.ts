import axios from 'axios';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import { promisify } from 'util';
import { appConfig } from '../config';
import { providerConfigs } from '../config';

const execFileAsync = promisify(execFile);

const LM_SERVER_POLL_MS = 500;
const LM_SERVER_START_TIMEOUT_MS = 90_000;
const COMFY_API_WARMUP_MS = 2_000;

function ts(): string {
  return new Date().toISOString();
}

function normModelKey(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, '/');
}

function modelBaseName(value: string): string {
  const normalized = normModelKey(value);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

export function modelKeysMatch(requested: string, loadedKey: string): boolean {
  const a = normModelKey(requested);
  const b = normModelKey(loadedKey);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith(`/${b}`) || b.endsWith(`/${a}`)) return true;
  return modelBaseName(a) === modelBaseName(b);
}

export function isModelLoaded(
  requested: string,
  status: LmStudioStatus,
): boolean {
  return status.loaded.some((instance) =>
    modelKeysMatch(requested, instance.model_key),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LmStudioInstance {
  instance_id: string;
  model_key: string;
  display_name?: string;
  context_length?: number;
}

export interface LmStudioStatus {
  server: 'up' | 'down';
  loaded: LmStudioInstance[];
  loaded_count: number;
  error?: string;
}

export interface ComfyStatus {
  running: boolean;
  pid: number | null;
  api_reachable: boolean;
  vram?: {
    total_mb?: number;
    free_mb?: number;
    used_mb?: number;
  };
  error?: string;
}

export interface GpuStatus {
  lmstudio: LmStudioStatus;
  comfy: ComfyStatus;
  conflict: boolean;
}

function lmHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = providerConfigs.local.apiKey;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function lmJsonHeaders(): Record<string, string> {
  return { ...lmHeaders(), 'Content-Type': 'application/json' };
}

function lmUrl(path: string): string {
  return `${appConfig.gpu.lmStudioNativeUrl.replace(/\/$/, '')}${path}`;
}

async function readComfyPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(appConfig.gpu.comfyPidFile, 'utf8');
    const pid = Number(raw.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getLmStudioStatus(): Promise<LmStudioStatus> {
  try {
    const { data } = await axios.get<{
      models?: Array<{
        key?: string;
        display_name?: string;
        loaded_instances?: Array<{
          id?: string;
          config?: { context_length?: number };
        }>;
      }>;
    }>(lmUrl('/api/v1/models'), {
      headers: lmHeaders(),
      timeout: 10_000,
    });

    const loaded: LmStudioInstance[] = [];
    for (const model of data.models ?? []) {
      for (const instance of model.loaded_instances ?? []) {
        if (!instance.id) continue;
        loaded.push({
          instance_id: instance.id,
          model_key: model.key ?? instance.id,
          display_name: model.display_name,
          context_length: instance.config?.context_length,
        });
      }
    }

    return {
      server: 'up',
      loaded,
      loaded_count: loaded.length,
    };
  } catch (err) {
    return {
      server: 'down',
      loaded: [],
      loaded_count: 0,
      error: err instanceof Error ? err.message : 'LM Studio unreachable',
    };
  }
}

export async function getComfyStatus(): Promise<ComfyStatus> {
  const pid = await readComfyPid();
  const running = pid !== null && (await isProcessAlive(pid));

  let apiReachable = false;
  let vram: ComfyStatus['vram'];
  let error: string | undefined;

  try {
    const { data } = await axios.get<{
      system?: {
        ram_total?: number;
        ram_free?: number;
      };
      devices?: Array<{
        type?: string;
        vram_total?: number;
        vram_free?: number;
      }>;
    }>(`${appConfig.gpu.comfyApiUrl.replace(/\/$/, '')}/system_stats`, {
      timeout: 8_000,
    });
    apiReachable = true;

    const gpu = (data.devices ?? []).find((d) => d.type === 'cuda') ??
      data.devices?.[0];
    if (gpu?.vram_total !== undefined) {
      const totalMb = Math.round(gpu.vram_total / (1024 * 1024));
      const freeMb = Math.round((gpu.vram_free ?? 0) / (1024 * 1024));
      vram = {
        total_mb: totalMb,
        free_mb: freeMb,
        used_mb: totalMb - freeMb,
      };
    }
  } catch (err) {
    if (!running) {
      error = err instanceof Error ? err.message : 'ComfyUI API unreachable';
    }
  }

  return {
    running: running || apiReachable,
    pid: running ? pid : null,
    api_reachable: apiReachable,
    vram,
    error,
  };
}

export async function getGpuStatus(): Promise<GpuStatus> {
  const [lmstudio, comfy] = await Promise.all([
    getLmStudioStatus(),
    getComfyStatus(),
  ]);

  return {
    lmstudio,
    comfy,
    conflict: lmstudio.loaded_count > 0 && comfy.running,
  };
}

export async function unloadLmStudio(instanceId?: string): Promise<{
  unloaded: string[];
}> {
  const status = await getLmStudioStatus();
  if (status.server === 'down') {
    throw new Error(status.error ?? 'LM Studio server is down');
  }

  const targets = instanceId
    ? status.loaded.filter((i) => i.instance_id === instanceId)
    : status.loaded;

  if (targets.length === 0) {
    return { unloaded: [] };
  }

  const unloaded: string[] = [];
  for (const instance of targets) {
    await axios.post(
      lmUrl('/api/v1/models/unload'),
      { instance_id: instance.instance_id },
      { headers: lmJsonHeaders(), timeout: 120_000 },
    );
    unloaded.push(instance.instance_id);
  }

  return { unloaded };
}

async function runLmStudioCli(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(appConfig.gpu.lmStudioCli, args, {
    timeout: 300_000,
  });
  return (stdout || stderr || '').trim();
}

export async function startLmStudioServer(): Promise<void> {
  const status = await getLmStudioStatus();
  if (status.server === 'up') {
    return;
  }

  console.log(`[${ts()}] gpu: starting LM Studio server via ${appConfig.gpu.lmStudioCli}`);
  await runLmStudioCli(['server', 'start']);
}

export async function waitForLmStudioServer(
  timeoutMs = LM_SERVER_START_TIMEOUT_MS,
): Promise<LmStudioStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getLmStudioStatus();
    if (status.server === 'up') {
      return status;
    }
    await sleep(LM_SERVER_POLL_MS);
  }

  throw new Error('LM Studio server did not become reachable');
}

export interface EnsureLocalModelResult {
  skipped: boolean;
  actions: string[];
  status: GpuStatus;
}

export async function ensureLocalModelReady(opts: {
  model: string;
  context_length?: number;
}): Promise<EnsureLocalModelResult> {
  const model = opts.model.trim();
  if (!model) {
    throw new Error('No local model specified');
  }

  const actions: string[] = [];
  let lm = await getLmStudioStatus();

  if (lm.server === 'up' && isModelLoaded(model, lm)) {
    const status = await getGpuStatus();
    return { skipped: true, actions: ['already_ready'], status };
  }

  console.log(
    `[${ts()}] gpu: preparing local model "${model}" (server=${lm.server}, loaded=${lm.loaded_count})`,
  );

  const comfyBefore = await getComfyStatus();
  if (comfyBefore.running) {
    await stopComfy();
    actions.push('stopped_comfy');
    await sleep(COMFY_API_WARMUP_MS);
  }

  if (lm.server === 'down') {
    await startLmStudioServer();
    actions.push('started_lmstudio_server');
    lm = await waitForLmStudioServer();
  }

  if (!isModelLoaded(model, lm)) {
    if (lm.loaded_count > 0) {
      const unloaded = await unloadLmStudio();
      if (unloaded.unloaded.length > 0) {
        actions.push(`unloaded_lmstudio:${unloaded.unloaded.join(',')}`);
      }
    }

    const loaded = await loadLmStudio({
      model,
      ...(opts.context_length !== undefined
        ? { context_length: opts.context_length }
        : {}),
    });
    actions.push(`loaded_lmstudio:${loaded.model}`);
    lm = await getLmStudioStatus();
    if (!isModelLoaded(model, lm)) {
      throw new Error(`LM Studio load finished but "${model}" is not loaded`);
    }
  }

  const comfyAfterLoad = await getComfyStatus();
  if (!comfyAfterLoad.running) {
    await startComfy();
    actions.push(comfyBefore.running ? 'restarted_comfy' : 'started_comfy');
  }

  const status = await getGpuStatus();
  console.log(`[${ts()}] gpu: local prep done (${actions.join(', ') || 'no-op'})`);
  return { skipped: false, actions, status };
}

export async function loadLmStudio(opts?: {
  model?: string;
  context_length?: number;
}): Promise<{ instance_id?: string; model: string }> {
  const model = opts?.model?.trim() || providerConfigs.local.defaultModel;
  if (!model) {
    throw new Error('No model specified and LOCAL_DEFAULT_MODEL is empty');
  }

  const body: { model: string; context_length?: number } = { model };
  if (opts?.context_length !== undefined) {
    body.context_length = opts.context_length;
  } else if (appConfig.gpu.lmLoadContextLength !== undefined) {
    body.context_length = appConfig.gpu.lmLoadContextLength;
  }

  const { data } = await axios.post<{
    instance_id?: string;
    status?: string;
  }>(
    lmUrl('/api/v1/models/load'),
    body,
    { headers: lmJsonHeaders(), timeout: 300_000 },
  );

  return { instance_id: data.instance_id, model };
}

async function runComfyScript(action: 'start' | 'stop' | 'status'): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    'bash',
    [appConfig.gpu.comfyRunScript, action],
    { timeout: 120_000 },
  );
  return (stdout || stderr || '').trim();
}

export async function startComfy(): Promise<{ message: string }> {
  const message = await runComfyScript('start');
  return { message };
}

export async function stopComfy(): Promise<{ message: string }> {
  const message = await runComfyScript('stop');
  return { message };
}

export type GpuMode = 'llm' | 'images';

export async function setGpuMode(mode: GpuMode): Promise<{
  mode: GpuMode;
  actions: string[];
  status: GpuStatus;
}> {
  const actions: string[] = [];

  if (mode === 'llm') {
    const comfyBefore = await getComfyStatus();
    if (comfyBefore.running) {
      await stopComfy();
      actions.push('stopped_comfy');
    }

    const lm = await getLmStudioStatus();
    if (lm.server === 'up' && lm.loaded_count === 0) {
      try {
        const loaded = await loadLmStudio();
        actions.push(`loaded_lmstudio:${loaded.model}`);
      } catch (err) {
        actions.push(
          `load_lmstudio_skipped:${err instanceof Error ? err.message : 'failed'}`,
        );
      }
    } else if (lm.loaded_count > 0) {
      actions.push('lmstudio_already_loaded');
    } else {
      actions.push('lmstudio_server_down');
    }
  } else {
    const unloaded = await unloadLmStudio();
    if (unloaded.unloaded.length > 0) {
      actions.push(`unloaded_lmstudio:${unloaded.unloaded.join(',')}`);
    } else {
      actions.push('lmstudio_already_empty');
    }

    const comfyBefore = await getComfyStatus();
    if (!comfyBefore.running) {
      await startComfy();
      actions.push('started_comfy');
    } else {
      actions.push('comfy_already_running');
    }
  }

  return {
    mode,
    actions,
    status: await getGpuStatus(),
  };
}
