import axios from 'axios';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import { promisify } from 'util';
import { appConfig, providerConfigs } from '../config';

const execFileAsync = promisify(execFile);

const LM_SERVER_POLL_MS = 500;
const LM_SERVER_START_TIMEOUT_MS = 90_000;
const COMFY_API_WARMUP_MS = 2_000;
const COMFY_START_TIMEOUT_MS = 30_000;
const COMFY_STOP_TIMEOUT_MS = 15_000;
const GRACEFUL_WAIT_TIMEOUT_MS = 120_000;
const GRACEFUL_WAIT_POLL_MS = 2_000;

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// Transition State Machine
// ============================================================

export type TransitionPhase =
  | 'idle'
  | 'stopping_comfy'
  | 'starting_comfy'
  | 'stopping_lmstudio'
  | 'starting_lmstudio'
  | 'unloading_lmstudio'
  | 'loading_lmstudio'
  | 'switching_to_llm'
  | 'switching_to_images'
  | 'waiting_for_comfy_queue'
  | 'waiting_for_lmstudio_idle';

export interface Transition {
  phase: TransitionPhase;
  started_at: string;
  detail: string;
}

let currentTransition: Transition | null = null;

function setTransition(phase: TransitionPhase, detail: string): void {
  currentTransition = {
    phase,
    started_at: new Date().toISOString(),
    detail,
  };
  console.log(`[${ts()}] gpu transition: ${phase} — ${detail}`);
}

function clearTransition(): void {
  currentTransition = null;
}

function getTransition(): Transition | null {
  return currentTransition;
}

function updateTransitionDetail(detail: string): void {
  if (currentTransition) {
    currentTransition.detail = detail;
  }
}

// ============================================================
// Types
// ============================================================

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
  queue_running: number;
  queue_pending: number;
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
  transition: Transition | null;
}

// ============================================================
// Helpers
// ============================================================

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

// ============================================================
// Status queries
// ============================================================

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

async function getComfyQueueInfo(): Promise<{ running: number; pending: number }> {
  try {
    const { data } = await axios.get<{
      queue_running?: unknown[];
      queue_pending?: unknown[];
    }>(
      `${appConfig.gpu.comfyApiUrl.replace(/\/$/, '')}/queue`,
      { timeout: 5_000 },
    );
    return {
      running: Array.isArray(data.queue_running) ? data.queue_running.length : 0,
      pending: Array.isArray(data.queue_pending) ? data.queue_pending.length : 0,
    };
  } catch {
    return { running: 0, pending: 0 };
  }
}

export async function getComfyStatus(): Promise<ComfyStatus> {
  const pid = await readComfyPid();
  const running = pid !== null && (await isProcessAlive(pid));

  let apiReachable = false;
  let vram: ComfyStatus['vram'];
  let error: string | undefined;
  let queueRunning = 0;
  let queuePending = 0;

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

    const queue = await getComfyQueueInfo();
    queueRunning = queue.running;
    queuePending = queue.pending;
  } catch (err) {
    if (!running) {
      error = err instanceof Error ? err.message : 'ComfyUI API unreachable';
    }
  }

  return {
    running: running || apiReachable,
    pid: running ? pid : null,
    api_reachable: apiReachable,
    queue_running: queueRunning,
    queue_pending: queuePending,
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
    transition: getTransition(),
  };
}

// ============================================================
// LM Studio operations
// ============================================================

export async function unloadLmStudio(
  instanceId?: string,
  force = false,
): Promise<{ unloaded: string[] }> {
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

async function startLmStudioServer(): Promise<void> {
  const status = await getLmStudioStatus();
  if (status.server === 'up') return;

  console.log(`[${ts()}] gpu: starting LM Studio server via ${appConfig.gpu.lmStudioCli}`);
  await runLmStudioCli(['server', 'start']);
}

export async function waitForLmStudioServer(
  timeoutMs = LM_SERVER_START_TIMEOUT_MS,
): Promise<LmStudioStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getLmStudioStatus();
    if (status.server === 'up') return status;
    await sleep(LM_SERVER_POLL_MS);
  }

  throw new Error('LM Studio server did not become reachable');
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

// ============================================================
// ComfyUI operations
// ============================================================

async function runComfyScript(action: 'start' | 'stop' | 'status'): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    'bash',
    [appConfig.gpu.comfyRunScript, action],
    { timeout: 120_000 },
  );
  return (stdout || stderr || '').trim();
}

async function waitForComfyApi(
  timeoutMs = COMFY_START_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await axios.get(
        `${appConfig.gpu.comfyApiUrl.replace(/\/$/, '')}/system_stats`,
        { timeout: 3_000 },
      );
      return true;
    } catch {
      // Still waiting
    }
    await sleep(COMFY_API_WARMUP_MS);
  }
  return false;
}

async function waitForComfyProcessStop(
  pid: number,
  timeoutMs = COMFY_STOP_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) return true;
    await sleep(500);
  }
  return false;
}

async function waitForComfyQueueIdle(
  timeoutMs = GRACEFUL_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const queue = await getComfyQueueInfo();
    updateTransitionDetail(
      `Waiting for ComfyUI queue to drain (running=${queue.running}, pending=${queue.pending}, attempt=${attempt})`,
    );
    if (queue.running === 0 && queue.pending === 0) return true;
    await sleep(GRACEFUL_WAIT_POLL_MS);
  }
  return false;
}

export async function startComfy(): Promise<{
  message: string;
  api_reachable: boolean;
  queue_running: number;
  queue_pending: number;
}> {
  setTransition('starting_comfy', 'Running ComfyUI start script...');

  const statusBefore = await getComfyStatus();
  if (statusBefore.running && statusBefore.api_reachable) {
    clearTransition();
    return {
      message: 'ComfyUI already running',
      api_reachable: true,
      queue_running: statusBefore.queue_running,
      queue_pending: statusBefore.queue_pending,
    };
  }

  const rawMessage = await runComfyScript('start');

  updateTransitionDetail('Waiting for ComfyUI API to become reachable...');
  const apiReachable = await waitForComfyApi();

  const statusAfter = await getComfyStatus();
  clearTransition();

  return {
    message: rawMessage,
    api_reachable: apiReachable,
    queue_running: statusAfter.queue_running,
    queue_pending: statusAfter.queue_pending,
  };
}

export async function stopComfy(force = false): Promise<{
  message: string;
  stopped: boolean;
  was_queued: boolean;
  queue_running: number;
  queue_pending: number;
}> {
  const statusBefore = await getComfyStatus();

  if (!statusBefore.running && !statusBefore.api_reachable) {
    return {
      message: 'ComfyUI not running',
      stopped: false,
      was_queued: false,
      queue_running: 0,
      queue_pending: 0,
    };
  }

  const hasQueue = statusBefore.queue_running > 0 || statusBefore.queue_pending > 0;

  if (hasQueue && !force) {
    // Graceful: wait for queue to drain
    setTransition(
      'waiting_for_comfy_queue',
      `ComfyUI has ${statusBefore.queue_running} running + ${statusBefore.queue_pending} pending jobs. Waiting...`,
    );
    const drained = await waitForComfyQueueIdle();
    if (!drained) {
      clearTransition();
      throw new Error(
        `ComfyUI queue did not drain within ${GRACEFUL_WAIT_TIMEOUT_MS / 1000}s (running=${statusBefore.queue_running}, pending=${statusBefore.queue_pending}). Use force=true to interrupt.`,
      );
    }
  }

  if (hasQueue && force) {
    // Force: interrupt first
    setTransition('stopping_comfy', 'Force stop: interrupting active jobs...');
    try {
      await axios.post(
        `${appConfig.gpu.comfyApiUrl.replace(/\/$/, '')}/interrupt`,
        {},
        { timeout: 10_000 },
      );
    } catch {
      // Interrupt may fail if API is already down — proceed with stop
    }
  }

  setTransition('stopping_comfy', 'Running ComfyUI stop script...');
  const rawMessage = await runComfyScript('stop');

  // Wait for process to actually die
  const pid = statusBefore.pid;
  if (pid) {
    updateTransitionDetail('Waiting for ComfyUI process to terminate...');
    const stopped = await waitForComfyProcessStop(pid);
    if (!stopped) {
      // Force kill
      try {
        process.kill(pid, 9);
      } catch {
        // Already dead
      }
    }
  }

  clearTransition();

  return {
    message: rawMessage,
    stopped: true,
    was_queued: hasQueue,
    queue_running: statusBefore.queue_running,
    queue_pending: statusBefore.queue_pending,
  };
}

// ============================================================
// ensureLocalModelReady
// ============================================================

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

  setTransition('starting_lmstudio', `Ensuring LM Studio is running and model "${model}" is loaded...`);

  if (lm.server === 'down') {
    await startLmStudioServer();
    actions.push('started_lmstudio_server');
    lm = await waitForLmStudioServer();
    updateTransitionDetail('LM Studio server is up, checking model...');
  }

  if (!isModelLoaded(model, lm)) {
    if (lm.loaded_count > 0) {
      setTransition('unloading_lmstudio', `Unloading ${lm.loaded_count} existing model(s) before loading new one...`);
      const unloaded = await unloadLmStudio();
      if (unloaded.unloaded.length > 0) {
        actions.push(`unloaded_lmstudio:${unloaded.unloaded.join(',')}`);
      }
    }

    setTransition('loading_lmstudio', `Loading model "${model}"...`);
    const loaded = await loadLmStudio({
      model,
      ...(opts.context_length !== undefined
        ? { context_length: opts.context_length }
        : {}),
    });
    actions.push(`loaded_lmstudio:${loaded.model}`);

    lm = await getLmStudioStatus();
    if (!isModelLoaded(model, lm)) {
      clearTransition();
      throw new Error(`LM Studio load finished but "${model}" is not loaded`);
    }
  }

  clearTransition();

  const status = await getGpuStatus();
  console.log(`[${ts()}] gpu: local prep done (${actions.join(', ') || 'no-op'})`);
  return { skipped: false, actions, status };
}

// ============================================================
// GPU Mode switching
// ============================================================

export type GpuMode = 'llm' | 'images';

export async function setGpuMode(
  mode: GpuMode,
  force = false,
): Promise<{
  mode: GpuMode;
  actions: string[];
  status: GpuStatus;
}> {
  const actions: string[] = [];

  if (mode === 'llm') {
    // Stop ComfyUI → load LLM
    setTransition('switching_to_llm', 'Stopping ComfyUI...');

    const comfyBefore = await getComfyStatus();
    if (comfyBefore.running) {
      const stopResult = await stopComfy(force);
      actions.push(`stopped_comfy${stopResult.was_queued ? '_after_queue_drain' : ''}`);
    } else {
      actions.push('comfy_already_stopped');
    }

    let lm = await getLmStudioStatus();
    if (lm.server === 'up' && lm.loaded_count === 0) {
      setTransition('loading_lmstudio', 'Loading default model...');
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
    } else if (lm.server === 'down') {
      // LM Studio server is down — wait for watchdog to start it
      updateTransitionDetail('LM Studio server is down — waiting for watchdog to start it...');
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await sleep(2_000);
        lm = await getLmStudioStatus();
        if (lm.server === 'up') break;
        updateTransitionDetail(`Waiting for LM Studio (${Math.round((deadline - Date.now()) / 1000)}s remaining)...`);
      }
      if (lm.server === 'up' && lm.loaded_count === 0) {
        setTransition('loading_lmstudio', 'Loading default model...');
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
    }
  } else {
    // Unload LLM → start ComfyUI
    setTransition('switching_to_images', 'Unloading LM Studio models...');

    const lmBefore = await getLmStudioStatus();
    if (lmBefore.loaded_count > 0) {
      setTransition('unloading_lmstudio', `Unloading ${lmBefore.loaded_count} model(s)...`);
      const unloaded = await unloadLmStudio(undefined, force);
      if (unloaded.unloaded.length > 0) {
        actions.push(`unloaded_lmstudio:${unloaded.unloaded.join(',')}`);
      }
    } else {
      actions.push('lmstudio_already_empty');
    }

    setTransition('starting_comfy', 'Starting ComfyUI...');
    const comfyBefore = await getComfyStatus();
    if (!comfyBefore.running) {
      const startResult = await startComfy();
      actions.push(`started_comfy${startResult.api_reachable ? '' : '_api_unreachable'}`);
    } else {
      actions.push('comfy_already_running');
    }
  }

  clearTransition();

  return {
    mode,
    actions,
    status: await getGpuStatus(),
  };
}