import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appConfig } from '../config';
import type { ChatCompletionRequest, CompletionRequestContext, ProviderId } from '../types';
import { attachDumpFile } from './concurrency-queue';

export const dumpLiveAls = new AsyncLocalStorage<string>();

export interface RequestDumpEntry {
  provider: ProviderId;
  model: string;
  upstreamUrl: string;
  status: number;
  stream: boolean;
  tokensIn: number;
  tokensOut: number;
  dollars: number;
  requestBody: ChatCompletionRequest;
  responseBody: unknown;
  requestCtx: CompletionRequestContext;
  error?: string;
}

function sortableTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const padMs = (n: number) => String(n).padStart(3, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${padMs(d.getMilliseconds())}`;
}

function mysqlTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function wordsFromText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) {
    end -= 1;
  }
  return end > 0 ? text.slice(0, end).replace(/_+$/, '') : 'empty';
}

function buildFilenameSlug(text: string, maxFirst = 50, maxLast = 50, maxBytes = 120): string {
  const words = wordsFromText(text);
  if (words.length === 0) return 'empty';

  let selected: string[];
  if (words.length <= maxFirst) {
    selected = words;
  } else {
    const first = words.slice(0, maxFirst);
    const last = words.slice(-maxLast);
    const overlap = maxFirst + maxLast - words.length;
    selected = overlap >= maxLast ? words : [...first, ...last.slice(Math.max(0, overlap))];
  }

  const slug = selected.map((w) => w.slice(0, 30)).join('_');
  return truncateUtf8Bytes(slug, maxBytes) || 'empty';
}

function buildDumpFilename(loggedAt: Date, userRequestText: string): string {
  const prefix = `${sortableTimestamp(loggedAt)}_`;
  const maxBytes = 200;
  const slugBudget = Math.max(32, maxBytes - Buffer.byteLength(`${prefix}.txt`, 'utf8'));
  const slug = buildFilenameSlug(userRequestText, 50, 50, slugBudget);
  return truncateUtf8Bytes(`${prefix}${slug}.txt`, maxBytes);
}

function formatSection(title: string, body: string): string {
  return `\n=== ${title} ===\n${body}\n`;
}

function serializeBody(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function ensureReqLogDir(): Promise<void> {
  await fs.mkdir(appConfig.reqLogDir, { recursive: true });
}

/**
 * Move all files from req/ into req-old/ at startup, archiving previous run's dumps.
 * Clears req-old/ first to avoid stale accumulation.
 */
export async function rotateReqLogs(): Promise<void> {
  const src = appConfig.reqLogDir;
  const dst = appConfig.reqOldDir;

  try {
    // Ensure source directory exists (may be first run)
    await fs.mkdir(src, { recursive: true });

    const entries = await fs.readdir(src, { withFileTypes: true });
    if (entries.length === 0) return;

    // Clear old destination
    if (existsSync(dst)) {
      await fs.rm(dst, { recursive: true, force: true });
    }
    await fs.mkdir(dst, { recursive: true });

    let moved = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      try {
        await fs.rename(srcPath, dstPath);
        moved++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[req-rotate] failed to move ${entry.name}: ${msg}`);
      }
    }
    if (moved > 0) {
      console.log(`[req-rotate] moved ${moved} files from req/ → req-old/`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[req-rotate] rotation failed: ${msg}`);
  }
}

export async function logRequestDump(entry: RequestDumpEntry): Promise<string | undefined> {
  let filePath = '';
  let filename = '';
  try {
    await ensureReqLogDir();

    const loggedAt = new Date();
    filename = buildDumpFilename(loggedAt, entry.requestCtx.userRequestText);
    filePath = path.join(appConfig.reqLogDir, filename);

    const headerLines = [
      `logged_at: ${mysqlTimestamp(loggedAt)}`,
      `provider: ${entry.provider}`,
      `model: ${entry.model}`,
      `upstream_url: ${entry.upstreamUrl}`,
      `status: ${entry.status}`,
      `stream: ${entry.stream}`,
      `tokens_in: ${entry.tokensIn}`,
      `tokens_out: ${entry.tokensOut}`,
      `tokens_total: ${entry.tokensIn + entry.tokensOut}`,
      `cost_usd: ${entry.dollars.toFixed(8)}`,
      `request_kb: ${entry.requestCtx.requestKb.toFixed(2)}`,
      `user_request_preview: ${entry.requestCtx.userRequestPreview}`,
    ];
    if (entry.error) {
      headerLines.push(`error: ${entry.error}`);
    }
    const liveId = dumpLiveAls.getStore();
    if (liveId) headerLines.push(`live_id: ${liveId}`);

    const content = [
      formatSection('META', headerLines.join('\n')),
      formatSection('REQUEST', serializeBody(entry.requestBody)),
      formatSection('RESPONSE', serializeBody(entry.responseBody)),
    ].join('');

    await fs.writeFile(filePath, content, 'utf8');
    if (liveId) attachDumpFile(liveId, filename);
    return filename;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[request-dump] write failed: ${message}`, { filePath, filename });
  }
  return undefined;
}

export interface RequestDumpSections {
  meta: string;
  request: string;
  response: string;
  error: string;
  file: string;
}

function parseDumpSections(content: string): { meta: string; request: string; response: string } {
  const parts: Record<string, string> = { META: '', REQUEST: '', RESPONSE: '' };
  const re = /\n=== ([A-Z]+) ===\n/g;
  const hits: Array<{ title: string; index: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    hits.push({ title: m[1], index: m.index, bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].index : content.length;
    parts[hits[i].title] = content.slice(hits[i].bodyStart, end).trim();
  }
  return { meta: parts.META, request: parts.REQUEST, response: parts.RESPONSE };
}

export async function readRequestDump(filename: string): Promise<RequestDumpSections | null> {
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return null;
  }
  const dirs = [appConfig.reqLogDir, appConfig.reqOldDir];
  for (const dir of dirs) {
    const filePath = path.join(dir, filename);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const { meta, request, response } = parseDumpSections(content);
      const errLine = meta.split('\n').find((l) => l.startsWith('error: '));
      return {
        meta,
        request,
        response,
        error: errLine ? errLine.slice('error: '.length) : '',
        file: filePath,
      };
    } catch {
      continue;
    }
  }
  return null;
}