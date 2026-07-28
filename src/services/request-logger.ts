/** Collapse whitespace, then truncate with middle cut (max visible width). */
export function truncateMiddle(text: string, maxLen = 20): string {
  const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  const edge = Math.floor((maxLen - 3) / 2);
  return `${clean.slice(0, edge)}...${clean.slice(-edge)}`;
}

/** Show first ~head chars + "..." + last (maxLen - head - 3) chars.
 *  Useful to see the *end* of streaming responses. */
export function truncateEnd(text: string, maxLen = 512, head = 30): string {
  const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
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

export function logIncoming(opts: {
  provider: string;
  model: string;
  stream: boolean;
  preview: string;
  endpointPrefix: string;
  requestedModel: string;
}): void {
  const { provider, stream, preview, endpointPrefix, requestedModel } = opts;
  const effectiveModel = opts.model; // the resolved upstream model
  const tag = modelTag({ endpointPrefix, requestedModel, effectiveModel });
  console.log(
    `[${ts()}] ← IN  [${endpointPrefix}] ${provider} | ${tag} | ${stream ? 'stream' : 'sync'} | "${truncateEnd(preview, 512)}"`,
  );
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
      return trimmed.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
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
}): void {
  const { provider, status, preview, stream, detail, endpointPrefix, requestedModel, effectiveModel, fallbackFrom } = opts;
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
}

export function logProxyError(opts: {
  provider: string;
  message: string;
  endpointPrefix?: string;
  requestedModel?: string;
  effectiveModel?: string;
}): void {
  const { provider, message, endpointPrefix, requestedModel, effectiveModel } = opts;
  const modelStr = endpointPrefix && requestedModel && effectiveModel
    ? `${modelTag({ endpointPrefix, requestedModel, effectiveModel })} | `
    : '';
  console.log(
    `[${ts()}] ERR  [${endpointPrefix ?? '?'}] ${provider} | ${modelStr}${truncateEnd(message, 200)}`,
  );
}