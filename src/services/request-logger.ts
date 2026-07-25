/** Collapse whitespace, then truncate with middle cut (max visible width). */
export function truncateMiddle(text: string, maxLen = 20): string {
  const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  const edge = Math.floor((maxLen - 3) / 2);
  return `${clean.slice(0, edge)}...${clean.slice(-edge)}`;
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

export function logIncoming(opts: {
  provider: string;
  model: string;
  stream: boolean;
  preview: string;
}): void {
  const { provider, model, stream, preview } = opts;
  console.log(
    `[${ts()}] ← IN  ${provider} | ${truncateMiddle(model, 40)} | ${stream ? 'stream' : 'sync'} | "${truncateMiddle(preview)}"`,
  );
}

export function logOutgoing(opts: {
  provider: string;
  url: string;
  model: string;
  stream: boolean;
}): void {
  const { provider, url, model, stream } = opts;
  console.log(
    `[${ts()}] → OUT ${provider} | ${truncateMiddle(url, 50)} | ${truncateMiddle(model, 40)} | ${stream ? 'stream' : 'sync'}`,
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
  model: string;
  status: number;
  preview: string;
  stream: boolean;
  detail?: string;
}): void {
  const { provider, model, status, preview, stream, detail } = opts;
  const tag = status >= 400 ? 'ERR' : 'OK ';
  const tail =
    status >= 400
      ? detail
        ? `reason: ${truncateMiddle(detail, 120)}`
        : preview
          ? `reason: ${truncateMiddle(preview, 120)}`
          : 'reason: (no upstream detail)'
      : `"${truncateMiddle(preview)}"`;
  console.log(
    `[${ts()}] ${tag}  ${provider} | ${status} | ${truncateMiddle(model, 40)} | ${stream ? 'stream' : 'sync'} | ${tail}`,
  );
}

export function logProxyError(opts: {
  provider: string;
  model: string;
  message: string;
}): void {
  const { provider, model, message } = opts;
  console.log(
    `[${ts()}] ERR  ${provider} | ${truncateMiddle(model, 40)} | ${truncateMiddle(message, 60)}`,
  );
}
