/** Collapse whitespace, then truncate with middle cut (max visible width). */
export function truncateMiddle(text: string, maxLen = 20): string {
  const clean = text.replace(/[\\r\\n\\t]+/g, ' ').replace(/\\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  const edge = Math.floor((maxLen - 3) / 2);
  return `${clean.slice(0, edge)}...${clean.slice(-edge)}`;
}

/** Show first ~head chars + "..." + last (maxLen - head - 3) chars.
 *  Useful to see the *end* of streaming responses. */
export function truncateEnd(text: string, maxLen = 512, head = 30): string {
  const clean = text.replace(/[\\r\\n\\t]+/g, ' ').replace(/\\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  if (head >= maxLen) return `...${clean.slice(-(maxLen - 3))}`;
  const tailLen = maxLen - head - 3;
  return `${clean.slice(0, head)}...${clean.slice(-tailLen)}`;
}

function ts(): string {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${day} ${h}:${mi}:${s} MSK`;
}

export interface LogOptions {
  endpointPrefix: string;
  requestedModel: string;
  effectiveModel: string;
  fallbackFrom?: string;
}

function modelTag(opts: LogOptions): string {
  const { requestedModel, effectiveModel, fallbackFrom } = opts;
  let tag = `${requestedModel} → ${effectiveModel}`;
  if (fallbackFrom) {
    tag += ` ⚡fallback: ${fallbackFrom}`;
  }
  return tag;
}

// ─────────────────────────────────────────────────────────────
// WebSocket dashboard emitter
// ─────────────────────────────────────────────────────────────

import type { DashboardEvent, LogEvent } from '../types';
import { getRequestId as _getRequestId } from './request-context';

let _wsEmitter: ((e: LogEvent) => void) | null = null;

/**
 * Register a WebSocket event emitter.
 * Call this once at startup to wire up the dashboard WS adapter.
 */
export function registerWsEmitter(fn: (e: LogEvent) => void): void {
  _wsEmitter = fn;
}

function getRequestId(): string {
  return _getRequestId() ?? 'no-request-id';
}

function makeTimestamp(): string {
  return new Date().toISOString();
}

function buildEvent(
  type: DashboardEvent['type'],
  extra: Partial<DashboardEvent> = {},
): DashboardEvent {
  return {
    type,
    timestamp: makeTimestamp(),
    requestId: getRequestId(),
    ...extra,
  };
}

function emitWs(event: DashboardEvent): void {
  if (!_wsEmitter) return;
  try {
    _wsEmitter(event);
  } catch (err) {
    console.error('[request-logger] WS emit failed:', (err as Error)?.message ?? String(err));
  }
}

export function logIncoming(opts: {
  provider: string;
  model: string;
  stream: boolean;
  preview: string;
  endpointPrefix: string;
  requestedModel: string;
  userMessagePreview?: string;
}): void {
  const { provider, stream, preview, endpointPrefix, requestedModel, userMessagePreview } = opts;
  const effectiveModel = opts.model;
  const tag = modelTag({ endpointPrefix, requestedModel, effectiveModel });
  console.log(
    `[${ts()}] ← IN  [${endpointPrefix}] ${provider} | ${tag} | ${stream ? 'stream' : 'sync'} | "${truncateEnd(preview, 512)}"`,
  );

  emitWs(buildEvent('request:start', {
    endpointPrefix,
    requestedModel,
    effectiveModel,
    provider: provider as DashboardEvent['provider'],
    stream,
    userMessagePreview: userMessagePreview ?? truncateEnd(preview, 200),
    completionPreview: undefined,
    status: undefined,
    fallbackFrom: undefined,
    fallbackReason: undefined,
    fallbackChain: undefined,
    fallbackAttempt: undefined,
    errorCode: undefined,
    errorDetail: undefined,
    tokensIn: undefined,
    tokensOut: undefined,
    dollars: undefined,
    metadata: undefined,
  }));
}

export function logOutgoing(opts: {
  provider: string;
  url: string;
  stream: boolean;
  endpointPrefix: string;
  requestedModel: string;
  effectiveModel: string;
}): void {
  const { provider, url, stream, endpointPrefix, requestedModel, effectiveModel } = opts;
  const tag = modelTag({ endpointPrefix, requestedModel, effectiveModel });
  console.log(
    `[${ts()}] → OUT [${endpointPrefix}] ${provider} | ${truncateMiddle(url, 50)} | ${tag} | ${stream ? 'stream' : 'sync'}`,
  );

  emitWs(buildEvent('request:forward', {
    endpointPrefix,
    requestedModel,
    effectiveModel,
    provider: provider as DashboardEvent['provider'],
    stream,
    metadata: { url },
  }));
}

/** Human-readable upstream failure text for proxy logs. */
export function formatUpstreamError(status: number, body: unknown): string {
  if (body == null || body === '') {
    return `HTTP ${status} (empty body)`;
  }

  let parsed: unknown = body;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return `HTTP ${status} (empty body)`;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return trimmed.replace(/[\\r\\n\\t]+/g, ' ').replace(/\\s+/g, ' ').trim();
    }
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as {
      error?: { message?: string; type?: string; code?: string | number };
      message?: string;
      detail?: string;
    };
    const parts: string[] = [];
    const msg = obj.error?.message ?? obj.message ?? obj.detail;
    if (msg) parts.push(msg);
    if (obj.error?.type) parts.push(`type=${obj.error.type}`);
    if (obj.error?.code != null) parts.push(`code=${obj.error.code}`);
    if (parts.length) return parts.join(' | ');
    return JSON.stringify(parsed);
  }

  return String(parsed);
}

export function logResponse(opts: {
  provider: string;
  status: number;
  preview: string;
  stream: boolean;
  detail?: string;
  endpointPrefix: string;
  requestedModel: string;
  effectiveModel: string;
  fallbackFrom?: string;
  tokensIn?: number;
  tokensOut?: number;
  dollars?: number;
}): void {
  const { provider, status, preview, stream, detail, endpointPrefix, requestedModel, effectiveModel, fallbackFrom, tokensIn, tokensOut, dollars } = opts;
  const tag = status >= 400 ? 'ERR' : 'OK ';
  const modelStr = modelTag({ endpointPrefix, requestedModel, effectiveModel, fallbackFrom });
  const tail =
    status >= 400
      ? detail
        ? `reason: ${truncateEnd(detail, 200)}`
        : preview
          ? `reason: ${truncateEnd(preview, 200)}`
          : 'reason: (no upstream detail)'
      : `"${truncateEnd(preview, 512)}"`;
  console.log(
    `[${ts()}] ${tag}  [${endpointPrefix}] ${provider} | ${status} | ${modelStr} | ${stream ? 'stream' : 'sync'} | ${tail}`,
  );

  emitWs(buildEvent('request:response', {
    endpointPrefix,
    requestedModel,
    effectiveModel,
    provider: provider as DashboardEvent['provider'],
    status,
    stream,
    completionPreview: truncateEnd(preview, 512),
    fallbackFrom,
    tokensIn,
    tokensOut,
    dollars,
    errorDetail: status >= 400 ? (detail ?? preview) : undefined,
  }));
}

export function logProxyError(opts: {
  provider: string;
  message: string;
  endpointPrefix?: string;
  requestedModel?: string;
  effectiveModel?: string;
  requestId?: string; // optional override (used by fallback chain)
}): void {
  const { provider, message, endpointPrefix, requestedModel, effectiveModel } = opts;
  const modelStr = endpointPrefix && requestedModel && effectiveModel
    ? `${modelTag({ endpointPrefix, requestedModel, effectiveModel })} | `
    : '';
  console.log(
    `[${ts()}] ERR  [${endpointPrefix ?? '?'}] ${provider} | ${modelStr}${truncateEnd(message, 200)}`,
  );

  // Try to extract error code from message prefix
  const codeMatch = message.match(/^\[([A-Z0-9_-]+)\]/);
  const errorCode = codeMatch ? codeMatch[1] : undefined;

  emitWs(buildEvent('request:error', {
    endpointPrefix,
    requestedModel,
    effectiveModel,
    provider: provider as DashboardEvent['provider'],
    errorCode,
    errorDetail: message,
  }));
}
