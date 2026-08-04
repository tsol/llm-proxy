import fs from 'fs';
import path from 'path';
import { appConfig } from '../config';

/**
 * Rate-limit diagnostic logger.
 *
 * Writes raw 429 responses (headers + truncated body) to logs/rate-limit.log
 * so we can understand the exact rate-limit format used by upstreams
 * (gonka, deepseek, groq, ...) before implementing server-level cooling.
 */

const RATE_LIMIT_LOG_FILE = () => path.join(appConfig.logsDir, 'rate-limit.log');

export interface RateLimitLogEntry {
  provider: string;
  model: string;
  upstreamUrl: string;
  status: number;
  headers: Record<string, string>;
  rawBody?: string;
}

const RATE_LIMIT_HEADER_KEYS = ['retry-after', 'x-ratelimit', 'ratelimit', 'x-llm-ratelimit'];

function filterRateLimitHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (RATE_LIMIT_HEADER_KEYS.some((k) => lower.includes(k))) {
      out[key] = value;
    }
  }
  return out;
}

function serializeEntry(entry: RateLimitLogEntry): string {
  const lines: string[] = [
    `--- ${new Date().toISOString()} ---`,
    `provider: ${entry.provider}`,
    `model: ${entry.model}`,
    `upstream: ${entry.upstreamUrl}`,
    `status: ${entry.status}`,
  ];

  const rlHeaders = filterRateLimitHeaders(entry.headers);
  const headerLines = Object.entries(rlHeaders);
  if (headerLines.length > 0) {
    lines.push('rate-limit-headers:');
    for (const [key, value] of headerLines) {
      lines.push(`  ${key}: ${value}`);
    }
  } else {
    lines.push('rate-limit-headers: (none)');
  }

  if (entry.rawBody) {
    // Truncate body to 4KB to keep the log digestible.
    const truncated =
      entry.rawBody.length > 4096 ? entry.rawBody.slice(0, 4096) + '\n...[truncated]' : entry.rawBody;
    lines.push('body:');
    lines.push(truncated);
  }

  lines.push('');
  return lines.join('\n');
}

/** Append a rate-limit diagnostic entry to logs/rate-limit.log (atomic-ish append). */
export function logRateLimit(entry: RateLimitLogEntry): void {
  try {
    const p = RATE_LIMIT_LOG_FILE();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, serializeEntry(entry), 'utf-8');
  } catch (err) {
    // Never let logging break request flow.
    console.error('[rate-limit-log] failed to write:', (err as Error)?.message ?? String(err));
  }
}