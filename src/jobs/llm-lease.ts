import { appConfig, providerConfigs } from '../config';
import { resolveModelQuirk } from '../providers/metadata';
import { capacity } from './resources';
import { acquireLlmSlot } from './scheduler';

export type LlmLeaseResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'gpu_busy' | 'client-closed'; etaSec?: number };

export async function acquireLocalLlmLease(opts: {
  model: string;
  preview: string;
  onClientClose: () => boolean;
  timeoutMs: number;
  principal?: string;
}): Promise<LlmLeaseResult> {
  const model = opts.model.trim();
  const quirk = resolveModelQuirk(model, providerConfigs.local.modelQuirks);
  const cap = await capacity();
  const exclusive = quirk?.gpuPrep?.exclusive === true;
  const vramMb = exclusive
    ? cap.vram_mb
    : (quirk?.gpuPrep?.vramMb ?? appConfig.services.localLlmVramMb);

  try {
    const { release } = await acquireLlmSlot({
      model,
      preview: opts.preview,
      principal: opts.principal,
      resources: { vram_mb: vramMb, ram_mb: 2000, cpu: 1 },
      requires: [`lmstudio:${model}`],
      evicts: ['*'],
      shared: true,
      estimateSec: 60,
      contextLength: quirk?.contextLength,
      contextSteps: quirk?.contextSteps,
      onClientClose: opts.onClientClose,
      timeoutMs: opts.timeoutMs,
    });
    return { ok: true, release };
  } catch (err) {
    const code = (err as { code?: string }).code;
    const etaSec = (err as { etaSec?: number }).etaSec;
    if (code === 'client-closed') {
      return { ok: false, reason: 'client-closed' };
    }
    return { ok: false, reason: 'gpu_busy', etaSec };
  }
}
