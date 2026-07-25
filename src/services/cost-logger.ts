import fs from 'fs/promises';
import path from 'path';
import { appConfig } from '../config';
import type { CostEntry } from '../types';
import {
  captureRequestContext,
  messageContentToTextExport as messageContentToText,
} from './request-context';

export { captureRequestContext } from './request-context';

const LOG_HEADER =
  'logged_at\tmodel\tprovider\tuser_request_75\trequest_kb\ttokens_in\ttokens_out\tdollars\n';

function mysqlTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function ensureCostLogDir(): Promise<void> {
  await fs.mkdir(path.dirname(appConfig.costLogPath), { recursive: true });
}

async function ensureLogHeader(): Promise<void> {
  await ensureCostLogDir();
  try {
    const stat = await fs.stat(appConfig.costLogPath);
    if (stat.size > 0) return;
  } catch {
    // file missing — write header below
  }
  await fs.appendFile(appConfig.costLogPath, LOG_HEADER, 'utf8');
}

export async function logCost(entry: CostEntry): Promise<void> {
  await ensureLogHeader();

  const line = [
    mysqlTimestamp(),
    entry.model,
    entry.provider,
    entry.userRequestPreview,
    entry.requestKb.toFixed(2),
    entry.tokensIn,
    entry.tokensOut,
    entry.dollars.toFixed(8),
  ].join('\t');

  await fs.appendFile(appConfig.costLogPath, `${line}\n`, 'utf8');
}

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / appConfig.fallbackCharsPerToken));
}

export function estimateTokensFromMessages(
  messages: Array<{ content?: unknown }> | undefined,
): number {
  if (!messages?.length) return 0;
  const joined = messages.map((m) => messageContentToText(m.content)).join('\n');
  return estimateTokensFromText(joined);
}

export function computeCost(
  tokensIn: number,
  tokensOut: number,
  inputPerMillion: number,
  outputPerMillion: number,
  cacheReadTokens = 0,
  cacheReadPerMillion = 0,
): number {
  return (
    (tokensIn / 1_000_000) * inputPerMillion +
    (tokensOut / 1_000_000) * outputPerMillion +
    (cacheReadTokens / 1_000_000) * cacheReadPerMillion
  );
}
