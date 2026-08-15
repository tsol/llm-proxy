/**
 * Shared image-output helpers.
 *
 * Client contract is always OpenAI /chat/completions with multimodal
 * `message.content` parts (`text` + `image_url` data URIs). Providers that
 * cannot speak that natively (Google generateContent, OpenRouter `images[]`)
 * convert at the adapter boundary.
 */

import type { ChatCompletionRequest, ChatMessage, ModelCapabilities } from './types';

export const VISION_IN: ModelCapabilities = {
  input_modalities: ['text', 'image'],
  output_modalities: ['text'],
};

export const VISION_AND_IMAGE_OUT: ModelCapabilities = {
  input_modalities: ['text', 'image'],
  output_modalities: ['text', 'image'],
};

const THINKING_KEYS = [
  'reasoning_effort',
  'reasoning',
  'thinking',
  'thinking_level',
  'thinkingLevel',
  'thinking_config',
  'thinkingConfig',
] as const;

const IMAGE_GEN_STRIP_KEYS = [
  ...THINKING_KEYS,
  'tools',
  'tool_choice',
  'functions',
  'function_call',
] as const;

/** Gemini / OpenRouter Nano Banana style ids: `…-image`, `…-image-preview`. */
export function isImageOutputModel(modelId: string): boolean {
  const id = modelId.replace(/^models\//, '').toLowerCase();
  return /(?:^|[-_/])image(?:-preview)?(?:$|[-_/])/.test(id) || /[-_/]image$/i.test(id);
}

export function stripThinkingParams(
  body: ChatCompletionRequest,
): ChatCompletionRequest {
  const next: ChatCompletionRequest = { ...body };
  for (const key of IMAGE_GEN_STRIP_KEYS) {
    if (key in next) delete next[key];
  }
  return next;
}

export function withImageModalities(
  body: ChatCompletionRequest,
): ChatCompletionRequest {
  if (Array.isArray(body.modalities)) return body;
  return { ...body, modalities: ['image', 'text'] };
}

export function assistantContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string' && text) parts.push(text);
  }
  return parts.join('');
}

export function assistantContentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const p = part as { type?: string; image_url?: unknown; inlineData?: unknown };
    if (p.type === 'image_url' || p.type === 'image' || p.image_url) return true;
    return false;
  });
}

interface OpenAIImagePart {
  type: 'image_url';
  image_url: { url: string };
}

interface OpenAITextPart {
  type: 'text';
  text: string;
}

type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

function dataUri(mimeType: string, data: string): string {
  const mime = mimeType && mimeType.includes('/') ? mimeType : `image/${mimeType || 'jpeg'}`;
  return `data:${mime};base64,${data}`;
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = url.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!m) return null;
  return { mimeType: m[1], data: m[2].replace(/\s/g, '') };
}

function openaiPartToGemini(part: unknown): Record<string, unknown> | null {
  if (typeof part === 'string') {
    return part ? { text: part } : null;
  }
  if (!part || typeof part !== 'object') return null;
  const p = part as {
    type?: string;
    text?: string;
    image_url?: { url?: string } | string;
  };
  if (p.type === 'text' || (typeof p.text === 'string' && !p.image_url)) {
    return p.text ? { text: p.text } : null;
  }
  const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
  if (!url) return null;
  const parsed = parseDataUrl(url);
  if (parsed) {
    return { inlineData: { mimeType: parsed.mimeType, data: parsed.data } };
  }
  return { fileData: { fileUri: url } };
}

function messagePartsToGemini(content: ChatMessage['content']): Record<string, unknown>[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: Record<string, unknown>[] = [];
  for (const part of content) {
    const mapped = openaiPartToGemini(part);
    if (mapped) parts.push(mapped);
  }
  return parts;
}

export function openaiMessagesToGemini(
  messages: ChatMessage[] | undefined,
): {
  contents: Array<{ role: string; parts: Record<string, unknown>[] }>;
  systemInstruction?: { parts: Array<{ text: string }> };
} {
  const systemChunks: string[] = [];
  const contents: Array<{ role: string; parts: Record<string, unknown>[] }> = [];

  for (const msg of messages ?? []) {
    const role = String(msg.role ?? '');
    if (role === 'system') {
      const text = assistantContentText(msg.content);
      if (text) systemChunks.push(text);
      continue;
    }
    if (role === 'tool' || role === 'function') continue;
    const geminiRole = role === 'assistant' ? 'model' : 'user';
    const parts = messagePartsToGemini(msg.content);
    if (parts.length === 0) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === geminiRole) {
      last.parts.push(...parts);
    } else {
      contents.push({ role: geminiRole, parts });
    }
  }

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Generate an image.' }] });
  }

  const systemText = systemChunks.join('\n\n');
  return {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
  };
}

export function openaiChatToGeminiGenerateContent(
  body: ChatCompletionRequest,
  _model: string,
): Record<string, unknown> {
  const cleaned = stripThinkingParams(body);
  const mapped = openaiMessagesToGemini(cleaned.messages);
  const generationConfig: Record<string, unknown> = {
    responseModalities: ['TEXT', 'IMAGE'],
  };
  if (typeof cleaned.max_tokens === 'number') {
    generationConfig.maxOutputTokens = cleaned.max_tokens;
  }
  if (typeof cleaned.temperature === 'number') {
    generationConfig.temperature = cleaned.temperature;
  }
  return {
    ...mapped,
    generationConfig,
  };
}

function geminiPartToOpenAI(part: unknown): OpenAIContentPart | null {
  if (!part || typeof part !== 'object') return null;
  const p = part as {
    text?: string;
    inlineData?: { mimeType?: string; mime_type?: string; data?: string };
    inline_data?: { mimeType?: string; mime_type?: string; data?: string };
  };
  if (typeof p.text === 'string' && p.text) {
    return { type: 'text', text: p.text };
  }
  const inline = p.inlineData ?? p.inline_data;
  if (inline?.data) {
    const mime = inline.mimeType ?? inline.mime_type ?? 'image/jpeg';
    return { type: 'image_url', image_url: { url: dataUri(mime, inline.data) } };
  }
  return null;
}

export function isGeminiNativeResponse(raw: unknown): boolean {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { candidates?: unknown }).candidates),
  );
}

export function geminiResponseToOpenAI(raw: unknown, model: string): Record<string, unknown> {
  const payload = raw as {
    candidates?: Array<{
      content?: { parts?: unknown[] };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
    modelVersion?: string;
  };
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const content: OpenAIContentPart[] = [];
  for (const part of parts) {
    const mapped = geminiPartToOpenAI(part);
    if (mapped) content.push(mapped);
  }
  const usage = payload.usageMetadata;
  const prompt = Number(usage?.promptTokenCount ?? 0);
  const completion = Number(usage?.candidatesTokenCount ?? 0);
  return {
    id: `chatcmpl-gemini-image`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: payload.modelVersion ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: Number(usage?.totalTokenCount ?? prompt + completion),
    },
  };
}

function asImagePart(raw: unknown): OpenAIImagePart | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as {
    type?: string;
    image_url?: { url?: string } | string;
    imageUrl?: { url?: string };
    url?: string;
    b64_json?: string;
  };
  const url =
    (typeof p.image_url === 'string' ? p.image_url : p.image_url?.url) ??
    p.imageUrl?.url ??
    p.url;
  if (typeof url === 'string' && url) {
    return { type: 'image_url', image_url: { url } };
  }
  if (typeof p.b64_json === 'string' && p.b64_json) {
    return { type: 'image_url', image_url: { url: dataUri('image/png', p.b64_json) } };
  }
  return null;
}

function mergeContentWithImages(content: unknown, extra: OpenAIImagePart[]): unknown {
  const parts: OpenAIContentPart[] = [];
  if (typeof content === 'string' && content) {
    parts.push({ type: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as OpenAIContentPart & { text?: string };
      if (p.type === 'text' || typeof p.text === 'string') {
        if (p.text) parts.push({ type: 'text', text: p.text });
        continue;
      }
      const img = asImagePart(p);
      if (img) parts.push(img);
    }
  }
  for (const img of extra) {
    const dup = parts.some(
      (p) => p.type === 'image_url' && p.image_url.url === img.image_url.url,
    );
    if (!dup) parts.push(img);
  }
  if (parts.length === 0) return content ?? '';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

/** Lift OpenRouter `message.images` (and similar) into OpenAI content parts. */
export function flattenAssistantImages(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const payload = raw as {
    choices?: Array<{ message?: { content?: unknown; images?: unknown[] } }>;
  };
  if (!Array.isArray(payload.choices)) return raw;
  let changed = false;
  const choices = payload.choices.map((choice) => {
    const message = choice?.message;
    if (!message) return choice;
    const extra: OpenAIImagePart[] = [];
    for (const img of message.images ?? []) {
      const part = asImagePart(img);
      if (part) extra.push(part);
    }
    if (extra.length === 0 && !assistantContentHasImage(message.content)) {
      return choice;
    }
    const content = mergeContentWithImages(message.content, extra);
    if (content === message.content && extra.length === 0) return choice;
    changed = true;
    const { images: _images, ...rest } = message as Record<string, unknown> & {
      images?: unknown;
    };
    return { ...choice, message: { ...rest, content } };
  });
  return changed ? { ...payload, choices } : raw;
}

export function googleNativeBaseUrl(openaiCompatBase: string): string {
  return openaiCompatBase.replace(/\/openai\/?$/, '').replace(/\/$/, '');
}

export function googleGenerateContentUrl(openaiCompatBase: string, model: string): string {
  const base = googleNativeBaseUrl(openaiCompatBase);
  const id = model.replace(/^models\//, '');
  return `${base}/models/${encodeURIComponent(id)}:generateContent`;
}
