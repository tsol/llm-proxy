import type { ChatMessage, ProviderId } from './types';

export type Modality = 'text' | 'image' | 'audio' | 'video';

export interface ModelCapabilities {
  input_modalities: Modality[];
  output_modalities: Modality[];
}

const TEXT_ONLY: ModelCapabilities = {
  input_modalities: ['text'],
  output_modalities: ['text'],
};

const TEXT_AND_IMAGE: ModelCapabilities = {
  input_modalities: ['text', 'image'],
  output_modalities: ['text'],
};

function contentPartModality(part: unknown): Modality | null {
  if (!part || typeof part !== 'object') return null;
  const type = String((part as { type?: string }).type ?? '').toLowerCase();
  if (!type || type === 'text') return 'text';
  if (type === 'image_url' || type === 'image' || type === 'input_image') {
    return 'image';
  }
  if (type === 'audio' || type === 'input_audio') return 'audio';
  if (type === 'video' || type === 'video_url') return 'video';
  return null;
}

/** Modalities present in chat message content (excluding plain text). */
export function messageInputModalities(
  messages: ChatMessage[] | undefined,
): Set<Modality> {
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

export function resolveModelCapabilities(
  provider: ProviderId,
  upstreamId: string,
  hints: { vision?: boolean; modelType?: string } = {},
): ModelCapabilities {
  if (provider === 'deepseek') {
    // Official api.deepseek.com chat/completions accepts text content only.
    return TEXT_ONLY;
  }

  if (provider === 'cursor' || provider === 'gonka') {
    return TEXT_ONLY;
  }

  if (provider === 'local') {
    if (hints.vision === true) return TEXT_AND_IMAGE;
    if (hints.modelType?.toLowerCase() === 'vlm') return TEXT_AND_IMAGE;
    return TEXT_ONLY;
  }

  if (provider === 'google') {
    const id = upstreamId.replace(/^models\//, '').toLowerCase();
    if (/embed|tts|transcribe|imagen|veo|audio|video|live|robotics/.test(id)) {
      return TEXT_ONLY;
    }
    if (/gemini|gemma|antigravity/.test(id)) return TEXT_AND_IMAGE;
    return TEXT_ONLY;
  }

  return TEXT_ONLY;
}

export function formatCapabilitiesError(
  model: string,
  unsupported: Modality[],
): string {
  const kinds = unsupported.join(', ');
  return (
    `Model "${model}" does not accept ${kinds} input. ` +
    `Use a vision-capable model (e.g. a local VLM or Gemini) or send text-only messages.`
  );
}
