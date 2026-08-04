import type { ChatMessage, CompletionRequestContext } from '../types';

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part && 'text' in part
          ? String((part as { text?: string }).text ?? '')
          : JSON.stringify(part),
      )
      .join(' ');
  }
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

function sanitizeLogText(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Pull spoken text out of Hermes voice-message wrappers when present. */
function unwrapVoiceMessage(text: string): string {
  const patterns = [
    /Here's what they said:\s*"([^"]*)"/i,
    /what they said:\s*"([^"]*)"/i,
    /voice message[^"]*"([^"]*)"/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return text;
}

export function extractLatestUserRequestText(
  messages: ChatMessage[] | undefined,
): string {
  if (!messages?.length) return '';

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return '';

  const raw = messageContentToText(lastUser.content);
  return unwrapVoiceMessage(raw);
}

export function captureRequestContext(
  messages: ChatMessage[] | undefined,
  previewLen = 75,
): CompletionRequestContext {
  const userRequestText = extractLatestUserRequestText(messages);
  const sanitized = sanitizeLogText(userRequestText);

  return {
    userRequestText,
    userRequestPreview: sanitized.slice(0, previewLen),
    requestKb: Buffer.byteLength(userRequestText, 'utf8') / 1024,
  };
}

export function messageContentToTextExport(content: unknown): string {
  return messageContentToText(content);
}

import { AsyncLocalStorage } from 'async_hooks';

const requestIdStorage = new AsyncLocalStorage<string>();

/** Run a request callback with a request id bound to its async context. */
export function runWithRequestId<T>(id: string, fn: () => T): T {
  return requestIdStorage.run(id, fn);
}

/** Get the current async-context request id (or undefined outside a request). */
export function getRequestId(): string | undefined {
  return requestIdStorage.getStore();
}
