import type { ChatMessage, ProviderId, ModelCapabilities } from './types';
import { getProvider } from './providers/registry';

export type Modality = 'text' | 'image' | 'audio' | 'video';

const TEXT_ONLY: ModelCapabilities = { input_modalities: ['text'], output_modalities: ['text'] };
const TEXT_AND_IMAGE: ModelCapabilities = { input_modalities: ['text', 'image'], output_modalities: ['text'] };

function contentPartModality(part: unknown): Modality | null {
  if (!part || typeof part !== 'object') return null;
  const type = String((part as { type?: string }).type ?? '').toLowerCase();
  if (!type || type === 'text') return 'text';
  if (type === 'image_url' || type === 'image' || type === 'input_image') return 'image';
  if (type === 'audio' || type === 'input_audio') return 'audio';
  if (type === 'video' || type === 'video_url') return 'video';
  return null;
}

export function messageInputModalities(messages: ChatMessage[] | undefined): Set<Modality> {
  const found = new Set<Modality>();
  for (const msg of messages ?? []) {
    const content = msg.content;
    if (typeof content === 'string') {
      if (content) found.add('text');
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const modality = contentPartModality(part);
      if (modality) found.add(modality);
    }
  }
  return found;
}

export function unsupportedInputModalities(
  capabilities: ModelCapabilities,
  requested: Set<Modality>,
): Modality[] {
  const allowed = new Set(capabilities.input_modalities);
  return [...requested].filter((m) => m !== 'text' && !allowed.has(m));
}

/** Resolve capabilities from provider quirks → model quirks → heuristics. */
export function resolveModelCapabilities(
  provider: ProviderId,
  upstreamId: string,
  hints: { vision?: boolean; modelType?: string } = {},
): ModelCapabilities {
  const adapter = getProvider(provider);
  const cfg = adapter.config;

  // 1. Model-level quirk override
  if (cfg.modelQuirks) {
    for (const [key, quirk] of Object.entries(cfg.modelQuirks)) {
      if (upstreamId === key || upstreamId.toLowerCase().startsWith(key.toLowerCase())) {
        if (quirk.capabilities) return quirk.capabilities;
        break;
      }
    }
  }

  // 2. Provider-level default capabilities from quirks (set in config)
  //    We handle this in config.ts by not having a quirks field — instead use hints + heuristics

  // 3. Heuristic-based resolution
  if (provider === 'deepseek' || provider === 'cursor' || provider === 'gonka' || provider === 'gonka-dahl' || provider === 'gonka-api' || provider === 'joingonka' || provider === 'gonka-mingles' || provider === 'gonka-router-io' || provider === 'gonkabroker' || provider === 'hyperfusion' || provider === 'groq' || provider === 'cerebras') {
    return TEXT_ONLY;
  }

  if (provider === 'openrouter') {
    // OpenRouter routes to many models; default to text-only unless hints say otherwise
    if (hints.vision === true) return TEXT_AND_IMAGE;
    return TEXT_ONLY;
  }

  if (provider === 'local') {
    if (hints.vision === true) return TEXT_AND_IMAGE;
    if (hints.modelType?.toLowerCase() === 'vlm') return TEXT_AND_IMAGE;
    return TEXT_ONLY;
  }

  if (provider === 'google') {
    const id = upstreamId.replace(/^models\//, '').toLowerCase();
    if (/embed|tts|transcribe|imagen|veo|audio|video|live|robotics/.test(id)) return TEXT_ONLY;
    if (/gemini|gemma|antigravity/.test(id)) return TEXT_AND_IMAGE;
    return TEXT_ONLY;
  }

  return TEXT_ONLY;
}

export function formatCapabilitiesError(model: string, unsupported: Modality[]): string {
  const kinds = unsupported.join(', ');
  return `Model "${model}" does not accept ${kinds} input. Use a vision-capable model (e.g. a local VLM or Gemini) or send text-only messages.`;
}